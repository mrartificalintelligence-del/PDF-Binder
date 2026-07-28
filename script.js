/**
 * Binder — client-side PDF merging
 * -----------------------------------------------------------------------
 * All PDF processing happens locally using PDF-Lib. No file is ever
 * transmitted to a server: every operation below runs in the browser's
 * own memory (ArrayBuffers / Blobs) and is available offline once the
 * page and its scripts have been loaded once.
 * ------------------------------------------------------------------- */

(function () {
  "use strict";

  /* ----------------------------- State ----------------------------- */
  // Each entry: { id, file } — `file` is the native File object.
  let queue = [];
  let idCounter = 0;
  let mergedObjectUrl = null; // tracked so we can revoke it and avoid leaks

  /* ----------------------------- Elements ----------------------------- */
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const fileListWrap = document.getElementById("file-list-wrap");
  const fileList = document.getElementById("file-list");
  const fileCountEl = document.getElementById("file-count");
  const toolActions = document.getElementById("tool-actions");
  const mergeBtn = document.getElementById("merge-btn");
  const clearBtn = document.getElementById("clear-btn");
  const loadingState = document.getElementById("loading-state");
  const loadingText = document.getElementById("loading-text");
  const successState = document.getElementById("success-state");
  const successMeta = document.getElementById("success-meta");
  const downloadBtn = document.getElementById("download-btn");
  const mergeAgainBtn = document.getElementById("merge-again-btn");
  const errorState = document.getElementById("error-state");
  const errorText = document.getElementById("error-text");
  const statusAnnouncer = document.getElementById("status-announcer");

  /* ----------------------------- Utilities ----------------------------- */

  /** Format bytes into a friendly, human-readable size string. */
  function formatBytes(bytes) {
    if (bytes === 0) return "0 KB";
    const units = ["B", "KB", "MB", "GB"];
    const exponent = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1
    );
    const value = bytes / Math.pow(1024, exponent);
    return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
  }

  /** Announce a message to assistive technology via the live region. */
  function announce(message) {
    statusAnnouncer.textContent = message;
  }

  /** Reset transient UI states (loading / success / error) to hidden. */
  function hideTransientStates() {
    loadingState.hidden = true;
    successState.hidden = true;
    errorState.hidden = true;
  }

  function showError(message) {
    hideTransientStates();
    errorText.textContent = message;
    errorState.hidden = false;
    announce(message);
  }

  /* ----------------------------- Rendering ----------------------------- */

  /** Re-render the entire file queue as accessible, reorderable list items. */
  function renderQueue() {
    fileList.innerHTML = "";

    const hasFiles = queue.length > 0;
    fileListWrap.hidden = !hasFiles;
    toolActions.hidden = !hasFiles;
    mergeBtn.disabled = queue.length < 1;
    fileCountEl.textContent = `(${queue.length})`;

    queue.forEach((entry, index) => {
      const li = document.createElement("li");
      li.className = "file-card";
      li.draggable = true;
      li.dataset.id = String(entry.id);
      li.setAttribute("aria-label", `${entry.file.name}, position ${index + 1} of ${queue.length}`);

      li.innerHTML = `
        <span class="file-drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>
        <span class="file-icon" aria-hidden="true">PDF</span>
        <span class="file-meta">
          <span class="file-name">${escapeHtml(entry.file.name)}</span>
          <span class="file-size">${formatBytes(entry.file.size)}</span>
        </span>
        <span class="file-order-controls">
          <button type="button" class="icon-btn move-up-btn" aria-label="Move ${escapeHtml(entry.file.name)} up" ${index === 0 ? "disabled" : ""}>▲</button>
          <button type="button" class="icon-btn move-down-btn" aria-label="Move ${escapeHtml(entry.file.name)} down" ${index === queue.length - 1 ? "disabled" : ""}>▼</button>
        </span>
        <button type="button" class="file-remove-btn" aria-label="Remove ${escapeHtml(entry.file.name)}">✕</button>
      `;

      // Remove
      li.querySelector(".file-remove-btn").addEventListener("click", () => {
        queue = queue.filter((q) => q.id !== entry.id);
        renderQueue();
        announce(`${entry.file.name} removed.`);
      });

      // Keyboard-accessible reordering
      li.querySelector(".move-up-btn").addEventListener("click", () => moveEntry(index, index - 1));
      li.querySelector(".move-down-btn").addEventListener("click", () => moveEntry(index, index + 1));

      // Native drag-and-drop reordering
      li.addEventListener("dragstart", (e) => {
        li.classList.add("is-dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(entry.id));
      });
      li.addEventListener("dragend", () => {
        li.classList.remove("is-dragging");
        clearDragOverStyles();
      });
      li.addEventListener("dragover", (e) => {
        e.preventDefault();
        const rect = li.getBoundingClientRect();
        const isTopHalf = e.clientY - rect.top < rect.height / 2;
        clearDragOverStyles();
        li.classList.add(isTopHalf ? "drag-over-top" : "drag-over-bottom");
      });
      li.addEventListener("dragleave", () => {
        li.classList.remove("drag-over-top", "drag-over-bottom");
      });
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        const draggedId = Number(e.dataTransfer.getData("text/plain"));
        const rect = li.getBoundingClientRect();
        const isTopHalf = e.clientY - rect.top < rect.height / 2;
        dropEntryNextTo(draggedId, entry.id, isTopHalf);
        clearDragOverStyles();
      });

      fileList.appendChild(li);
    });
  }

  function clearDragOverStyles() {
    fileList.querySelectorAll(".drag-over-top, .drag-over-bottom").forEach((el) => {
      el.classList.remove("drag-over-top", "drag-over-bottom");
    });
  }

  /** Move an entry from one index to another (used by keyboard controls). */
  function moveEntry(fromIndex, toIndex) {
    if (toIndex < 0 || toIndex >= queue.length) return;
    const [moved] = queue.splice(fromIndex, 1);
    queue.splice(toIndex, 0, moved);
    renderQueue();
  }

  /** Reposition a dragged entry relative to a drop target (used by DnD). */
  function dropEntryNextTo(draggedId, targetId, beforeTarget) {
    const fromIndex = queue.findIndex((q) => q.id === draggedId);
    if (fromIndex === -1) return;
    const [moved] = queue.splice(fromIndex, 1);

    let targetIndex = queue.findIndex((q) => q.id === targetId);
    if (targetIndex === -1) targetIndex = queue.length;
    const insertAt = beforeTarget ? targetIndex : targetIndex + 1;

    queue.splice(insertAt, 0, moved);
    renderQueue();
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  /* ----------------------------- File intake ----------------------------- */

  /** Add newly selected/dropped files to the queue, filtering to PDFs only. */
  function addFiles(fileListLike) {
    const incoming = Array.from(fileListLike);
    const pdfFiles = incoming.filter(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")
    );

    if (pdfFiles.length === 0 && incoming.length > 0) {
      showError("Please select PDF files only.");
      return;
    }

    hideTransientStates();

    pdfFiles.forEach((file) => {
      queue.push({ id: idCounter++, file });
    });

    renderQueue();
    announce(`${pdfFiles.length} file${pdfFiles.length === 1 ? "" : "s"} added. ${queue.length} total.`);
  }

  // Click / keyboard activation opens the file picker
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener("change", (e) => {
    addFiles(e.target.files);
    fileInput.value = ""; // allow re-selecting the same file later
  });

  // Drag & drop onto the dropzone
  ["dragenter", "dragover"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("is-dragover");
    });
  });

  ["dragleave", "dragend"].forEach((evt) => {
    dropzone.addEventListener(evt, () => dropzone.classList.remove("is-dragover"));
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("is-dragover");
    if (e.dataTransfer && e.dataTransfer.files) {
      addFiles(e.dataTransfer.files);
    }
  });

  /* ----------------------------- Clear ----------------------------- */

  clearBtn.addEventListener("click", () => {
    queue = [];
    renderQueue();
    hideTransientStates();
    revokeMergedUrl();
    announce("File queue cleared.");
  });

  mergeAgainBtn.addEventListener("click", () => {
    queue = [];
    renderQueue();
    hideTransientStates();
    revokeMergedUrl();
    dropzone.focus();
  });

  function revokeMergedUrl() {
    if (mergedObjectUrl) {
      URL.revokeObjectURL(mergedObjectUrl);
      mergedObjectUrl = null;
    }
  }

  /* ----------------------------- Merge ----------------------------- */

  mergeBtn.addEventListener("click", mergePdfs);

  async function mergePdfs() {
    if (queue.length === 0) return;

    if (typeof PDFLib === "undefined") {
      showError("The PDF engine failed to load. Check your connection and reload the page.");
      return;
    }

    hideTransientStates();
    loadingState.hidden = false;
    loadingText.textContent = "Merging your PDFs…";
    mergeBtn.disabled = true;
    clearBtn.disabled = true;
    announce("Merging your PDFs. Please wait.");

    try {
      const { PDFDocument } = PDFLib;
      const mergedPdf = await PDFDocument.create();

      for (let i = 0; i < queue.length; i++) {
        const entry = queue[i];
        loadingText.textContent = `Merging file ${i + 1} of ${queue.length}: ${entry.file.name}`;

        let sourceBytes;
        try {
          sourceBytes = await entry.file.arrayBuffer();
        } catch (err) {
          throw new Error(`Could not read "${entry.file.name}". The file may be corrupted.`);
        }

        let sourcePdf;
        try {
          sourcePdf = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
        } catch (err) {
          throw new Error(`"${entry.file.name}" doesn't look like a valid PDF and was skipped.`);
        }

        const copiedPages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
        copiedPages.forEach((page) => mergedPdf.addPage(page));
      }

      const mergedBytes = await mergedPdf.save();
      const blob = new Blob([mergedBytes], { type: "application/pdf" });

      revokeMergedUrl();
      mergedObjectUrl = URL.createObjectURL(blob);

      downloadBtn.href = mergedObjectUrl;
      successMeta.textContent = `${queue.length} files combined · ${formatBytes(blob.size)}`;

      hideTransientStates();
      successState.hidden = false;
      announce("Your merged PDF is ready to download.");
    } catch (err) {
      showError(err.message || "Something went wrong while merging your PDFs. Please try again.");
    } finally {
      mergeBtn.disabled = queue.length === 0;
      clearBtn.disabled = false;
      loadingState.hidden = true;
    }
  }

  /* ----------------------------- Scroll reveal ----------------------------- */

  function initScrollReveal() {
    const revealTargets = document.querySelectorAll(
      ".feature-card, .how-step, .tool-panel, .hero-content"
    );
    revealTargets.forEach((el) => el.classList.add("reveal"));

    if (!("IntersectionObserver" in window)) {
      revealTargets.forEach((el) => el.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );

    revealTargets.forEach((el) => observer.observe(el));
  }

  /* ----------------------------- Init ----------------------------- */

  document.addEventListener("DOMContentLoaded", () => {
    renderQueue();
    initScrollReveal();
  });
})();
