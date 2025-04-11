"use strict";

import { BemSnapshotConverter } from "./bem-snapshot.js";
import { SaveState } from "./savestate.js";
import { SaveStateStorage } from "./savestate.js";
import * as bootstrap from "bootstrap";

/**
 * Creates and manages the Snapshot UI for saving and loading emulator states.
 */
export class SnapshotUI {
    /**
     * Create a new SnapshotUI
     * @param {Object} processor - The 6502 processor instance
     * @param {Object} video - The video component
     * @param {Object} soundChip - The sound chip component
     * @param {Object} sysVia - The system VIA
     * @param {Object} userVia - The user VIA
     * @param {Object} crtc - The CRTC component
     */
    constructor(processor, video, soundChip, sysVia, userVia, crtc) {
        this.processor = processor;
        this.video = video;
        this.soundChip = soundChip;
        this.sysVia = sysVia;
        this.userVia = userVia;
        this.crtc = crtc;

        // Create storage for save states
        this.saveStateStorage = new SaveStateStorage();

        // Initialize event handlers after the DOM is fully loaded
        this.initEventHandlers();
    }

    /**
     * Initialize event handlers for the snapshot UI elements
     */
    initEventHandlers() {
        // Setup event handlers once the DOM is loaded
        document.addEventListener("DOMContentLoaded", () => {
            // Save state handler
            const saveStateBtn = document.getElementById("save-state");
            if (saveStateBtn) {
                saveStateBtn.addEventListener("click", () => this.saveState());
            }

            // Load state handler
            const loadStateBtn = document.getElementById("load-state");
            if (loadStateBtn) {
                loadStateBtn.addEventListener("click", () => this.loadState());
            }

            // Load B-Em snapshot handler
            const loadBemBtn = document.getElementById("load-bem-snapshot");
            if (loadBemBtn) {
                loadBemBtn.addEventListener("click", () => this.openBemSnapshotDialog());
            }

            // Export as B-Em snapshot handler
            const exportBemBtn = document.getElementById("export-bem-snapshot");
            if (exportBemBtn) {
                exportBemBtn.addEventListener("click", () => this.exportBemSnapshot());
            }

            // Setup file input for B-Em snapshot loading
            this.setupFileInput();
        });
    }

    /**
     * Setup hidden file input for B-Em snapshot loading
     */
    setupFileInput() {
        // Remove any existing input
        const existingInput = document.getElementById("bem-snapshot-input");
        if (existingInput) {
            existingInput.remove();
        }

        // Create a hidden file input for B-Em snapshots
        const bemFileInput = document.createElement("input");
        bemFileInput.type = "file";
        bemFileInput.id = "bem-snapshot-input";
        bemFileInput.accept = ".snp";
        bemFileInput.style.display = "none";
        bemFileInput.addEventListener("change", (e) => {
            if (e.target.files.length > 0) {
                this.loadBemSnapshot(e.target.files[0]);
            }
        });
        document.body.appendChild(bemFileInput);
    }

    /**
     * Save the current emulator state
     */
    saveState() {
        try {
            // Create a new save state
            const saveState = new SaveState();

            // Have the processor save its state
            this.processor.saveState(saveState);

            // Use a timestamp as the save name
            const saveName = `jsbeeb_${new Date().toISOString().replace(/[:.]/g, "-")}`;

            // Save to localStorage
            this.saveStateStorage.saveToLocalStorage(saveName, saveState);

            // Show success message
            this.showMessage(`State saved as "${saveName}"`, "success");
        } catch (error) {
            console.error("Error saving state:", error);
            this.showMessage("Error saving state: " + error.message, "danger");
        }
    }

    /**
     * Load a saved emulator state
     */
    loadState() {
        try {
            // Get the list of saved states
            const savedStates = this.saveStateStorage.getSaveList();

            if (savedStates.length === 0) {
                this.showMessage("No saved states found", "warning");
                return;
            }

            // Create a selection dialog for the user to choose which state to load
            this.showLoadStateDialog(savedStates);
        } catch (error) {
            console.error("Error loading state list:", error);
            this.showMessage("Error loading state list: " + error.message, "danger");
        }
    }

    /**
     * Show a dialog for selecting which state to load
     * @param {string[]} savedStates - List of saved state names
     */
    showLoadStateDialog(savedStates) {
        // Remove any existing dialog
        const existingDialog = document.getElementById("load-state-dialog");
        if (existingDialog) {
            existingDialog.remove();
        }

        // Create the dialog
        const dialog = document.createElement("div");
        dialog.id = "load-state-dialog";
        dialog.className = "modal fade";
        dialog.setAttribute("tabindex", "-1");
        dialog.setAttribute("aria-labelledby", "loadStateLabel");
        dialog.setAttribute("aria-hidden", "true");

        dialog.innerHTML = `
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title" id="loadStateLabel">Load Saved State</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body">
                        <div class="list-group">
                            ${savedStates
                                .map(
                                    (state) => `
                                <button type="button" class="list-group-item list-group-item-action load-state-item" 
                                        data-state="${state}">${state}</button>
                            `,
                                )
                                .join("")}
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        // Add event listeners for state selection
        const stateItems = dialog.querySelectorAll(".load-state-item");
        stateItems.forEach((item) => {
            item.addEventListener("click", () => {
                const stateName = item.getAttribute("data-state");
                this.loadSpecificState(stateName);
                // Get the modal instance from the DOM element
                const modalElement = document.getElementById("load-state-dialog");
                if (modalElement) {
                    const modalInstance = bootstrap.Modal.getInstance(modalElement);
                    if (modalInstance) {
                        modalInstance.hide();
                    }
                }
            });
        });

        // Show the dialog
        const modalInstance = new bootstrap.Modal(dialog);
        modalInstance.show();
    }

    /**
     * Load a specific saved state
     * @param {string} stateName - Name of the state to load
     */
    loadSpecificState(stateName) {
        try {
            console.log(`Loading state: ${stateName}`);

            // Load from localStorage
            const saveState = this.saveStateStorage.loadFromLocalStorage(stateName);

            if (!saveState) {
                this.showMessage(`Failed to load state "${stateName}"`, "danger");
                return;
            }

            // Ensure keyboard is enabled before loading state
            this.processor.sysvia.enableKeyboard();

            try {
                // Have the processor load the state
                this.processor.loadState(saveState);

                // Ensure keyboard is still enabled after loading
                if (!this.processor.sysvia.keyboardEnabled) {
                    console.log("Re-enabling keyboard after state load");
                    this.processor.sysvia.enableKeyboard();
                }

                // Show success message
                this.showMessage(`State "${stateName}" loaded successfully`, "success");
            } catch (loadError) {
                // Log the error
                console.error("Error in processor.loadState:", loadError);

                // Show error to user
                this.showMessage(`Error loading state: ${loadError.message}`, "danger");

                // Reset to get back to a known good state
                console.log("Performing hard reset after failed state load");
                this.processor.reset(true);
            }
        } catch (error) {
            console.error("Error preparing to load state:", error);
            this.showMessage("Error preparing to load state: " + error.message, "danger");

            // Try to reset processor to get back to a usable state
            try {
                this.processor.reset(true);
            } catch (resetError) {
                console.error("Error during reset:", resetError);
            }
        }
    }

    /**
     * Open file dialog to select a B-Em snapshot
     */
    openBemSnapshotDialog() {
        const bemFileInput = document.getElementById("bem-snapshot-input");
        if (bemFileInput) {
            bemFileInput.click();
        }
    }

    /**
     * Load a B-Em snapshot file
     * @param {File} file - The B-Em snapshot file
     */
    loadBemSnapshot(file) {
        this.showMessage(`Reading B-Em snapshot "${file.name}"...`, "info");

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                console.log(`B-Em Snapshot: Reading "${file.name}", ${e.target.result.byteLength} bytes`);

                // Convert ArrayBuffer to Uint8Array
                const snpData = new Uint8Array(e.target.result);

                // Use our converter to transform to jsbeeb SaveState
                this.showMessage(`Converting B-Em snapshot "${file.name}"...`, "info");
                const saveState = BemSnapshotConverter.fromBemSnapshot(snpData);

                if (!saveState) {
                    throw new Error("Failed to convert B-Em snapshot");
                }

                // Ensure keyboard is enabled before loading state
                this.processor.sysvia.enableKeyboard();

                // Log components in the saveState for debugging
                const components = Array.from(saveState.components.keys());
                console.log("B-Em snapshot components:", components);

                // Check if we have the minimal required components
                if (!saveState.getComponent("cpu")) {
                    throw new Error("Missing CPU state in snapshot");
                }

                // Check if we have any model information
                const modelInfo = saveState.getComponent("bem_model");
                if (modelInfo) {
                    console.log(`B-Em snapshot model: ${modelInfo.modelString || "Unknown"}`);
                    this.showMessage(`B-Em snapshot model: ${modelInfo.modelString || "Unknown"}`, "info");
                }

                // If we have memory latches, log them for debugging
                const memoryLatches = saveState.getComponent("memory_latches");
                if (memoryLatches) {
                    console.log("B-Em memory latches:", memoryLatches);
                }

                // Log CPU state before loading
                const cpuState = saveState.getComponent("cpu");
                console.log("CPU state before loading:", {
                    pc: cpuState.pc.toString(16),
                    a: cpuState.a.toString(16),
                    x: cpuState.x.toString(16),
                    y: cpuState.y.toString(16),
                });

                // Load the state into the processor with extra error handling
                console.log("Loading B-Em snapshot state into processor");

                try {
                    // First pause the processor to ensure proper state loading
                    const wasRunning = this.processor.isRunning();
                    if (wasRunning) {
                        this.processor.stop();
                    }

                    // Load the state
                    this.processor.loadState(saveState);
                    console.log("B-Em snapshot loaded successfully into processor");

                    // Resume the processor if it was running
                    if (wasRunning) {
                        this.processor.start();
                    }
                } catch (error) {
                    // Log the error to console
                    console.error("Error in processor.loadState:", error);

                    // Show error to user
                    this.showMessage(`Error loading state: ${error.message}`, "danger");

                    // Reset to get back to a known good state
                    console.log("Performing hard reset after failed state load");
                    this.processor.reset(true);

                    // Return early to prevent further processing
                    return;
                }

                // Ensure keyboard is still enabled after loading
                if (!this.processor.sysvia.keyboardEnabled) {
                    console.log("Re-enabling keyboard after B-Em snapshot load");
                    this.processor.sysvia.enableKeyboard();
                }

                // Clear any keys that might be "stuck" down
                this.processor.sysvia.clearKeys();

                // Log CPU state after loading
                console.log("CPU state after loading:", {
                    pc: this.processor.pc.toString(16),
                    a: this.processor.a.toString(16),
                    x: this.processor.x.toString(16),
                    y: this.processor.y.toString(16),
                });

                // Show success message
                this.showMessage(`B-Em snapshot "${file.name}" loaded successfully`, "success");
            } catch (error) {
                console.error("Error loading B-Em snapshot:", error);
                this.showMessage(`Error loading B-Em snapshot: ${error.message}`, "danger");
            }
        };

        reader.onerror = (e) => {
            console.error("FileReader error:", e);
            this.showMessage(`Error reading file: ${e.target.error}`, "danger");
        };

        // Start reading the file
        try {
            reader.readAsArrayBuffer(file);
        } catch (error) {
            console.error("Error starting file read:", error);
            this.showMessage(`Error reading file: ${error.message}`, "danger");
        }
    }

    /**
     * Export the current state as a B-Em snapshot
     */
    exportBemSnapshot() {
        try {
            // Create a new save state
            const saveState = new SaveState();

            // Have the processor save its state
            this.processor.saveState(saveState);

            // Convert to B-Em snapshot format
            const snpData = BemSnapshotConverter.toBemSnapshot(saveState);

            if (!snpData) {
                throw new Error("Failed to convert to B-Em format");
            }

            // Create a download link
            const blob = new Blob([snpData], { type: "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            const downloadLink = document.createElement("a");
            downloadLink.href = url;

            // Set filename with timestamp
            downloadLink.download = `jsbeeb_${new Date().toISOString().replace(/[:.]/g, "-")}.snp`;

            // Trigger download
            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);

            // Cleanup
            URL.revokeObjectURL(url);

            // Show success message
            this.showMessage("Exported as B-Em snapshot", "success");
        } catch (error) {
            console.error("Error exporting B-Em snapshot:", error);
            this.showMessage("Error exporting B-Em snapshot: " + error.message, "danger");
        }
    }

    /**
     * Show a message to the user
     * @param {string} message - The message to display
     * @param {string} type - The message type (success, danger, warning, info)
     */
    showMessage(message, type = "info") {
        // Check if there's already a message container
        let messageContainer = document.getElementById("snapshot-message");

        if (!messageContainer) {
            // Create a new message container
            messageContainer = document.createElement("div");
            messageContainer.id = "snapshot-message";
            messageContainer.style.position = "fixed";
            messageContainer.style.top = "60px";
            messageContainer.style.left = "50%";
            messageContainer.style.transform = "translateX(-50%)";
            messageContainer.style.zIndex = "9999";
            messageContainer.style.minWidth = "300px";
            document.body.appendChild(messageContainer);
        }

        // Create the alert message
        const alert = document.createElement("div");
        alert.className = `alert alert-${type} alert-dismissible fade show`;
        alert.role = "alert";
        alert.innerHTML = message;

        // Add close button
        const closeButton = document.createElement("button");
        closeButton.type = "button";
        closeButton.className = "btn-close";
        closeButton.setAttribute("data-bs-dismiss", "alert");
        closeButton.setAttribute("aria-label", "Close");
        alert.appendChild(closeButton);

        // Add to container
        messageContainer.appendChild(alert);

        // Remove after a delay if not closed
        setTimeout(() => {
            if (alert.parentNode === messageContainer) {
                messageContainer.removeChild(alert);
            }

            // Remove container if empty
            if (messageContainer.childNodes.length === 0) {
                messageContainer.remove();
            }
        }, 5000);
    }
}
