/* Module -- This superclass should be extended by all module implementations. */
'use strict';

var jsonfile = require('jsonfile');

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
    
    }
    
    
    param(key) { return this._params[key]; }
    get params() { return Object.assign({}, this._params); }
    
    env(name) { return this._environments[name]; }
    mod(name) { return this._modules[name]; }
    
    
    initialize(envs, mods, moduleRequest) {
        var params = {};
        
        //Load and check parameters
        
        try {
            var configname = this._envName.toLowerCase();
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
        
        if (!envs || !mods) return false;
        
        var envtypes = {};
        var modtypes = {};
        
        for (let env of Object.values(envs)) {
            envtypes[env.envName] = true;
        }
        
        for (let mod of Object.values(mods)) {
            if (mod.isMultiInstanceable) continue;
            modtypes[mod.modName] = true;
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
        
        this._environments = envs;
        this._modules = mods;

        return true;
    }
    
        
}


module.exports = Module;
