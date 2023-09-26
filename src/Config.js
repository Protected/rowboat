//Handle configuration files.

import fs from 'fs';
import yaml from 'yaml';

import logger from './Logger.js';

const CONFIG_PATH = "config/";
const CONFIG_FILE = "config.yaml";
const PACKAGE_PATH = "package.json";

//Master config. Auxiliary config files update this object too.
var config = {};

const DEFAULT_CONFIG = {
    "paths": {
        "logger": "[logs/]Y-MM[.log]",
        "data": "data/"
    },
    "environments": {
        "Discord": {
            type: "Discord"
        }
    },
    "behaviorCommon": {},
    "behaviors": [
        "Users",
        "Commands"
    ]
}


export function loadMasterConfig() {
    logger.info("Loading master config...");

    try {
        fs.accessSync(CONFIG_PATH + CONFIG_FILE, fs.constants.F_OK);
    } catch (e) {
        if (!generateMasterConfig()) {
            return false;
        }
    }

    try {
        fs.accessSync(CONFIG_PATH + CONFIG_FILE, fs.constants.R_OK);
    } catch (e) {
        logger.error("No permission to read master config.");
        return false;
    }

    try {
        const file = fs.readFileSync(CONFIG_PATH + CONFIG_FILE, 'utf8');
        config = yaml.parse(file);
    } catch (e) {
        logger.error("Failed to load master config. Error: " + e.message);
        return false;
    }
    
    if (config.paths && config.paths.logger) {
        logger.setPathTemplate(config.paths.logger);
    }

    if (!config.version) {
        try {
            const packagefile = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
            config.version = packagefile.version;
        } catch (e) {
            config.version = "0.0";
        }
    }

    if (Object.keys(config.environments).length < 1) {
        logger.warn("Environments provide connectivity. Please configure at least one environment.");
        return false;
    }

    for (let instanceName in config.environments) {
        if (!config.environments[instanceName].type) {
            logger.warn("No type provided for environment " + instanceName + " .");
            return false;
        }
    }

    if ((config.behaviors?.length || 0) < 1) {
        logger.warn("Behaviors provide functionality. Please configure at least one behavior.");
        return false;
    }

    for (let i = 0; i < config.behaviors.length; i++) {
        let check = config.behaviors[i];

        if (typeof check !== "object") {
            config.behaviors[i] = {name: check, type: check};
            check = config.behaviors[i];
        }

        if (!check.type) {
            logger.warn("No type provided for behavior " + i + " " + (beConfig.name || "(Unknown)") + " .");
            return false;
        }

        if (!check.name) {
            check.name = check.type;
        }
    }
    
    return true;
}

function generateMasterConfig() {
    logger.info("Generating default config...");
    config = DEFAULT_CONFIG;
    return saveMasterConfig();
}

export function saveMasterConfig() {

    logger.info("Saving master config...");

    try {
        let contents = yaml.stringify(config);
        fs.writeFileSync(CONFIG_PATH + CONFIG_FILE, contents);
    } catch (e) {
        logger.warn("Failed to save master config. Error: " + e.message);
        return false;
    }

    return true;
}

function loadAuxiliaryConfigFromFile(instanceName, suffix, target) {
    let filename = CONFIG_PATH + instanceName.toLowerCase() + "." + suffix + ".yaml";
    try {
        fs.accessSync(filename, fs.constants.F_OK);
    } catch (e) {
        return;
    }

    let data = {};

    try {
        const file = fs.readFileSync(filename, 'utf8');
        data = yaml.parse(file);
    } catch (e) {
        logger.error("Failed to load config file for " + instanceName + ". Error: " + e.message);
        return;
    }

    Object.assign(target, data);
}

export function getEnvironmentConfig(instanceName) {
    return config.environments[instanceName];
}

export function loadEnvironmentConfig(instanceName) {
    let envConfig = getEnvironmentConfig(instanceName);
    if (!envConfig) return null;
    loadAuxiliaryConfigFromFile(instanceName, "env", envConfig);
    return envConfig;
}

export function setEnvironmentDefaults(instanceName, defaults) {
    for (let key in defaults) {
        if (config.environments[instanceName][key] === undefined) {
            config.environments[instanceName][key] = defaults[key];
        }
    }
}

export function getBehaviorConfig(instanceName) {
    return config.behaviors.find(behavior => behavior?.name === instanceName);
}

export function getBehaviorCommonConfig() {
    return config.behaviorCommon || {};
}

export function loadBehaviorConfig(instanceName) {
    let beConfig = getBehaviorConfig(instanceName);
    if (!beConfig) return null;
    loadAuxiliaryConfigFromFile(instanceName, "be", beConfig);
    return beConfig;
}

export function setBehaviorDefaults(instanceName, defaults) {
    let beConfig = this.getBehaviorConfig(instanceName);
    for (let key in defaults) {
        if (beConfig[key] === undefined) {
            beConfig[key] = defaults[key];
        }
    }
}

export default new Proxy({
    loadMasterConfig, saveMasterConfig,
    getEnvironmentConfig, loadEnvironmentConfig, setEnvironmentDefaults,
    getBehaviorConfig, getBehaviorCommonConfig, loadBehaviorConfig, setBehaviorDefaults
}, {
    get: (target, prop, receiver) => {
        if (!target[prop]) {
            return config[prop];
        }
        return target[prop];
    }
});
