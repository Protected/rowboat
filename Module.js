/* Module -- This superclass should be extended by all module implementations. */
'use strict';

const jsonfile = require('jsonfile');
const fs = require('fs');
const { http, https } = require('follow-redirects');
const stream = require('stream');
const logger = require('./Logger.js');

class Module {

    get name() { return this._name; }
    get modName() { return this._modName; }
    
    
    /* Settings to override in your module */

    //Return a list of configuration parameters that *must* be provided in the config file.
    get requiredParams() { return []; }

    //Return a list of configuration parameters that can be provided in the config file. They should be initialized in the constructor.
    get optionalParams() { return []; }
    
    
    //Return true if the user can set up multiple instances of the module.
    //The user must provide
    get isMultiInstanceable() { return false; }

    //Request from the kernel a reference to itself. Don't do that if you don't need it. You probably don't need it.
    get isRootAccess() { return false; }
    

    //Configured environments instances must include environments of the types listed here for this module to load.
    get requiredEnvironments() { return []; }

    //Modules of the types listed here must be instances for this module to load.
    get requiredModules() { return []; }


    /* Constructor */

    //Override the constructor in your module. The first line should be: super('YourModule', name);
    //You should only use your constructor to initialize optional parameters and class attributes.

    constructor(modName, name) {
    
        this._modName = modName;
        this._name = (name ? name : modName);
        
        this._params = {};
        
        this._environments = null;
        this._modules = null;
        this._globalConfig = {};
    
    }    
    
    
    //Override this method in your module. The top line should be: if (!super.initialize(opt)) return false;
    //You can use this method to register event listeners.
    //When initialize runs, environments aren't yet connected. If you want to interact with an environment on connect,
    //  initialize should register a callback for the connect event for that environment.

    initialize(opt) {
        var params = {};
        
        //Load and check parameters
        
        var fileName = this.configfile;
        try {
            params = jsonfile.readFileSync(fileName);
            this.log('Initializing module of type ' + this._modName + '.');
        } catch(e) {
            if (e.code !== 'ENOENT') {
                this.log('error', `Error trying to load the config file ${fileName} because of: ${e}`);
            }
        }

        for (let reqParam of this.requiredParams) {
            if (params[reqParam] !== undefined && params[reqParam] !== null) this._params[reqParam] = params[reqParam];
            if (this._params[reqParam] === undefined) {
                this.log('error', 'Failed loading required parameter: ' + reqParam);
                return false;
            }
        };
        
        for (let optParam of this.optionalParams) {
            if (params[optParam] !== undefined) this._params[optParam] = params[optParam];
            if (this._params[optParam] === undefined) this._params[optParam] = null;
        }
        
        for (let key in params) {
            if (this._params[key] === undefined) this._params[key] = params[key];
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
    

    /* Miscellaneous helpers */

    //Obtain module parameters.
    param(key) { return this._params[key]; }
    get params() { return Object.assign({}, this._params); }

    get configfile() { 
        let configname = this._modName.toLowerCase();
        if (this.isMultiInstanceable) configname = this._name.toLowerCase() + "." + configname;
        configname = "config/" + configname + ".mod.json";
        return configname;
    }
    
    //Obtain a reference to another module or environment by instance name.
    //Only use a hardcoded name if the target module is not multi instanceable and is returned by requiredModules.
    env(name) { return this._environments[name]; }
    mod(name) { return this._modules[name]; }
    
    //Obtain entries from the main configuration file.
    config(key) {
        var path = key.split(".");
        var config = this._globalConfig;
        while (path.length && typeof config == "object") {
            config = config[path.shift()];
        }
        if (path.length) config = null;
        return config;
    }
    
    //Shortcut for obtaining the path where datafiles should be stored.
    dataPath() {
        return this.config("paths.data");
    }
    
    //Internal module logging (do not use to log environment events).
    log(method, subject) {
        if (subject === undefined) {
            subject = method;
            method = 'info';
        }
        logger.log(method, '|'+ this._name + '| ' + subject);
    }
    

    //Remove formatting from a string in such a way that the resulting message will not be formatted, even if environment-specific
    //  formatting is applied to it.

    stripNormalizedFormatting(text) {
        return text.replace(/__(.*?)__/g, "$1").replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1");
    }

    escapeNormalizedFormatting(text) {
        return text.replace(/__(.*?)__/g, "\\_\\_$1\\_\\_").replace(/\*\*(.*?)\*\*/g, "\\*\\*$1\\*\\*").replace(/\*(.*?)\*/g, "\\*$1\\*");
    }


    /* JSON datastores */
    

    //Load data from a datafile, if it exists, and return a datastore

    loadData(datafile, def, options) {
        if (!datafile) datafile = this.param('datafile');
        if (!datafile) datafile = this.name.toLowerCase() + ".data.json";
        let datafilepath = (options && options.abspath ? datafile : this.dataPath() + datafile);

        if (!options || !options.quiet) {
            this.log("Loading datafile: " + datafilepath);
        }

        //Create or load file from the filesystem

        try {
            fs.accessSync(datafilepath, fs.F_OK);
        } catch (e) {
            jsonfile.writeFileSync(datafilepath, (def !== undefined ? def : {}));
            this.log('warn', "Error accessing data file.");
        }

        let jsondata;
        try {
            jsondata = jsonfile.readFileSync(datafilepath);
        } catch (e) {
            this.log('error', `Error reading datafile: ${e}`);
            return false;
        }
        if (!jsondata) jsondata = (def !== undefined ? def : {});

        //Save method that persists the datastore when called.

        Object.defineProperty(jsondata, 'save', {
            value: () => {
                this.saveData(datafile, jsondata, options);
            }
        });

        return jsondata;
    }

    //Save any data into a datafile.

    saveData(datafile, data, options) {
        if (!datafile) datafile = this.param('datafile');
        if (!datafile) datafile = this.name.toLowerCase() + ".data.json";
        let datafilepath = (options && options.abspath ? datafile : this.dataPath() + datafile);

        if (!options || !options.quiet) {
            this.log("Saving datafile: " + datafilepath);
        }

        jsonfile.writeFileSync(datafilepath, data, (options && options.pretty ? {spaces: 4} : {}));
    }
    
    
    /* HTTP retrieval */
    
    //Returns Promise of URL contents
    async urlget(url, options, encoding) {
        if (!encoding && typeof options == "string") {
            encoding = options;
            options = undefined;
        }
        return new Promise((resolve, reject) => {
            let req;
            
            let callback = (res) => {
                if (encoding) {
                    res.setEncoding(encoding);
                }
                if (res.statusCode !== 200) {
                    reject("Request failed: " + res.statusCode);
                } else {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => resolve(body));
                }
            };
            
            if (url.match(/^https/i)) {
                req = https.get(url, options, callback);
            } else {
                req = http.get(url, options, callback);
            }
            req.on('error', reject);
        });
    }
    
    //Returns Promise of object from JSON pointed at by URL
    async jsonget(url, options) {
        let body = await this.urlget(url, options, 'utf8');
        return JSON.parse(body);
    }
    
    //Returns stream of URL contents
    streamget(url, options, extcallback) {
        let mod = this;
        let pt = new stream.PassThrough();
        let req;
        
        let callback = (res) => {
            res.on('error', (e) => {
                pt.emit('error', e);
            });
            res.pipe(pt);
            if (extcallback) extcallback(res);
            else pt.emit('response', res);
        };
        
        if (url.match(/^https/i)) {
            req = https.get(url, options, callback);
        } else {
            req = http.get(url, options, callback);
        }
        
        req.on('error', (e) => {
            pt.emit('error', e);
        });
        
        return pt;
    }
    
    //Downloads URL into a local file
    async downloadget(url, localpath) {
        return new Promise((resolve, reject) => {
            let stream = fs.createWriteStream(localpath);
            let download = this.streamget(url);
            download.pipe(stream);
            download.on('error', (e) => reject(e));
            stream.on('error', (e) => reject(e));
            stream.on('finish', () => resolve(localpath));
        });
    }

    
}


module.exports = Module;
