"use strict";

import { Model, CpuModel, findModel } from "./models.js";
import { NoiseAwareWdFdc } from "./wd-fdc.js";
import { NoiseAwareIntelFdc } from "./intel-fdc.js";

/**
 * ModelManager class for handling model configuration during save/load operations
 */
export class ModelManager {
    /**
     * Create a new Model instance from save state model information
     * @param {Object} modelInfo - Model information from save state
     * @returns {Model} Newly constructed Model object
     */
    static createModelFromInfo(modelInfo) {
        if (!modelInfo) {
            console.warn("No model information provided, using default BBC B model");
            // Return the standard BBC B model as fallback
            return findModel("BBC B with DFS 1.2");
        }

        // Determine FDC class from name
        let fdcClass = null;
        if (modelInfo.fdcType) {
            if (modelInfo.fdcType === "NoiseAwareWdFdc") {
                fdcClass = NoiseAwareWdFdc;
            } else if (modelInfo.fdcType === "NoiseAwareIntelFdc") {
                fdcClass = NoiseAwareIntelFdc;
            }
        } else {
            // Default FDC based on whether it's a Master
            fdcClass = modelInfo.isMaster ? NoiseAwareWdFdc : NoiseAwareIntelFdc;
        }

        // Convert CPU model from string or number
        let cpuModel = modelInfo.cpuModel;
        if (typeof cpuModel === 'string') {
            cpuModel = CpuModel[cpuModel] || 0; // Default to MOS6502 if not found
        }

        // Create SWRAM configuration
        const swram = Array.isArray(modelInfo.swram) 
            ? modelInfo.swram 
            : new Array(16).fill(modelInfo.isMaster ? true : false).map((v, i) => 
                // For Master, banks 4-7 are typically SWRAM
                modelInfo.isMaster ? (i >= 4 && i <= 7) : false
            );

        // Create and return a new Model instance
        return new Model(
            modelInfo.name || (modelInfo.isMaster ? "BBC Master (Generated)" : "BBC B (Generated)"),
            modelInfo.synonyms || [],
            modelInfo.os || ["os.rom", "BASIC.ROM"],
            cpuModel,
            !!modelInfo.isMaster,
            swram,
            fdcClass,
            modelInfo.tube || null,
            null // No CMOS override
        );
    }

    /**
     * Apply model configuration to emulator
     * @param {Object} config - Emulator configuration object 
     * @param {Object} saveState - SaveState object containing model information
     */
    static configureFromSaveState(config, saveState) {
        const modelInfo = saveState.getModelInfo();
        if (!modelInfo) {
            console.warn("No model information in save state, cannot reconfigure");
            return config;
        }

        // Create a new model from the saved information
        const model = this.createModelFromInfo(modelInfo);
        
        // Set the model in the config
        config.setModel(model);
        
        // Configure additional options based on model info
        if (modelInfo.hasTeletextAdaptor !== undefined) {
            config.setHasTeletextAdaptor(modelInfo.hasTeletextAdaptor);
        }
        
        if (modelInfo.hasMusic5000 !== undefined) {
            config.setHasMusic5000(modelInfo.hasMusic5000);
        }
        
        if (modelInfo.hasEconet !== undefined) {
            config.setHasEconet(modelInfo.hasEconet);
        }
        
        console.log(`Model reconfigured to ${model.name}`);
        return config;
    }
}