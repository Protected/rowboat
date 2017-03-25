/* Module -- This superclass should be extended by all module implementations. */
'use strict';

var jsonfile = require('jsonfile');
var logger = require('./Logger.js');

class Module {

    get name() { return this._name; }
    get modName() { return this._modName; }
    
    
    get requiredParams() { return []; }
    get optionalParams() { return []; }
    
    get isMultiInstanceable() { return false; }
    get isRootAccess() { return false; }
    
    get requiredEnvironments() { return []; }
    get requiredModules() { return []; }

    constructor(modName, name) {
    
        this._modName = modName;
        this._name = (name ? name : modName);
        
        this._params = {};
        
        this._environments = null;
        this._modules = null;
        this._globalConfig = {};
    
    }    
    
    
    param(key) { return this._params[key]; }
    get params() { return Object.assign({}, this._params); }
    
    env(name) { return this._environments[name]; }
    mod(name) { return this._modules[name]; }
    
    config(key) {
        var path = key.split(".");
        var config = this._globalConfig;
        while (path.length && typeof config == "object") {
            config = config[path.shift()];
        }
        if (path.length) config = null;
        return config;
    }
    
    dataPath() {
        return this.config("paths.data");
    }
    
    
    initialize(opt) {
        var params = {};
        
        //Load and check parameters
        
        try {
            var configname = this._modName.toLowerCase();
            if (this.isMultiInstanceable) configname = this._name.toLowerCase() + "." + configname;
            params = jsonfile.readFileSync("config/" + configname + ".mod.json");
        } catch(e) {}

        for (let reqParam of this.requiredParams) {
            if (params[reqParam]) this._params[reqParam] = params[reqParam];
            if (this._params[reqParam] === undefined) return false;
        };
        
        for (let optParam of this.optionalParams) {
            if (params[optParam]) this._params[optParam] = params[optParam];
            if (this._params[optParam] === undefined) this._params[optParam] = null;
        }
        
        //Check reference to environments/modules
        
        if (!opt.envs || !opt.mods) return false;
        
        var envtypes = {};
        var modtypes = {};
        
        for (let label in opt.envs) {
            envtypes[opt.envs[label].envName] = true;
        }
        
        for (let label in opt.mods) {
            if (opt.mods[label].isMultiInstanceable) continue;
            modtypes[opt.mods[label].modName] = true;
        }
        
        for (let reqenv of this.requiredEnvironments) {
            if (!envtypes[reqenv]) {
                return false;
            }
        }
        
        for (let reqmod of this.requiredModules) {
            if (!modtypes[reqmod]) {
                return false;
            }
        }
        
        this._environments = opt.envs;
        this._modules = opt.mods;
        
        this._globalConfig = opt.config;

        return true;
    }
    
    
    log(method, subject) {
        if (subject === undefined) {
            subject = method;
            method = 'info';
        }
        logger.log(method, '|'+ this._name + '| ' + subject);
    }
    

    stripNormalizedFormatting(text) {
        return text.replace(/__(.*?)__/g, "$1").replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1");
    }
    
        
}


module.exports = Module;
