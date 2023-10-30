/* Behavior -- This superclass should be extended by all behavior implementations. */

import fs from 'fs';
import fr from 'follow-redirects';
import querystring from 'querystring';
import stream from 'stream';
import jsonfile from 'jsonfile';

const { http, https } = fr;

import logger from './Logger.js';
import AsyncEventEmitter from './AsyncEventEmitter.js';

export default class Behavior extends AsyncEventEmitter {

    get name() { return this._name; }
    get type() { return this._type; }
    
    get expose() { return this._expose; }
    
    /* Settings to override in your behavior */

    //Returns a description for the behavior.
    get description() { return "A behavior."; }

    //Return a list of {n: NAME, d: DESCRIPTION} for each parameter of the behavior. ALL parameters must be listed.
    get params() { return []; }

    //Return a map of default values for optional parameters (those without defaults must be in the config file).
    get defaults() { return {}; }

    //A map of {KEY: TYPE} where each KEY is a parameter pointing to an instance of an environment of the given type.
    //Environments can then be accessed using this.env(KEY) .
    //If KEY is not explicitly declared as a parameter, a mandatory parameter will be automatically generated.
    get requiredEnvironments() { return {}; }

    //Maps of {KEY: TYPE} where each KEY is a parameter pointing to an instance of a behavior of the given type.
    //Behaviors can then be accessed using this.be(KEY) .
    //If KEY is not explicitly declared as a parameter, an optional parameter be automatically generated:
    
    get requiredBehaviors() { return {}; }  //with the default equal to TYPE (and the behavior must be in config)
    get optionalBehaviors() { return {}; }  //with the default equal to null

    //Return true if the user can set up multiple instances of behavior.
    get isMultiInstanceable() { return false; }

    //Request from the core a reference to itself.
    //It will be mapped under the key 'core'.
    get isCoreAccess() { return false; }

    //Replace with @decorators once they become available
    get synchronousMethods() { return ["escapeNormalizedFormatting", "stripNormalizedFormatting"]; }

    /* Constructor */

    //Override the constructor in your behavior. The first line should be: super('YourBehavior', name);
    //You should only use your constructor to initialize class attributes.

    constructor(type, name) {
        super();

        this._config = null;

        this._type = type;
        this._name = (name ? name : type);
        
        this._expose = false;
        
        this._envProxy = null;
        this._beProxy = null;
        this._optBeExists = null;
    
        this._hasInitialized = false;

        //Infer missing parameters for environments and behaviors

        this._trueParams = this.params;
        this._trueDefaults = this.defaults;

        for (let param in this.requiredBehaviors) {
            if (!this.params.find(entry => entry.n === param)) {
                this._trueParams.push({n: param, d: "Instance name of a " + this.requiredBehaviors[param] + " behavior"});
                this._trueDefaults[param] = param;
            }
        }

        for (let param in this.optionalBehaviors) {
            if (!this.params.find(entry => entry.n === param)) {
                this._trueParams.push({n: param, d: "Instance name of a " + this.optionalBehaviors[param] + " behavior (optional)"});
                this._trueDefaults[param] = null;
            }
        }

    }

    get config() { return this._config; }
    param(key) { return this.config.getBehaviorConfig(this._name)?.[key]; }

    optBeExists(key) { return this._optBeExists(this.param(key)); }

    env(key) { return this._envProxy(this.param(key)); }
    be(key) { return this._beProxy(this.param(key)); }
    
    
    //Override this method in your module. The top line should be: if (!super.initialize(opt)) return false;
    //You can use this method to register event listeners.
    //When initialize runs, environments aren't yet connected. If you want to interact with an environment on connect,
    //  initialize should register a callback for the connect event for that environment.

    initialize(opt) {
        
        this._config = opt.config;

        //Load and check parameters

        this.config.loadBehaviorConfig(this._name);
        this.config.setBehaviorDefaults(this._name, this.config.getBehaviorCommonConfig());
        this.config.setBehaviorDefaults(this._name, this._trueDefaults);
        
        let fail = false;
        for (let param of this.params) {
            if (this.param(param.n) === undefined) {
                this.log('error', `Parameter not found: ${param.n}`);
                fail = true;
            }
        }
        if (fail) return false;
              
        //Check reference to environments/behaviors

        for (let param in this.requiredEnvironments) {
            if (!opt.envExists(this.param(param), this.requiredEnvironments[param])) {
                this.log('error', "Could not initialize the behavior: " + this._name + " because the parameter " + param + " does not reference an instance of an environment with the type " + this.requiredEnvironments[param] + " .");
                return false;
            }
        }

        for (let param in this.requiredBehaviors) {
            if (!opt.beExists(this.param(param), this.requiredBehaviors[param])) {
                this.log('error', "Could not initialize the behavior: " + this._name + " because the parameter " + param + " does not reference an instance of a behavior with the type " + this.requiredBehaviors[param] + " .");
                return false;
            }
        }

        this._envProxy = opt.envProxy;
        this._beProxy = opt.beProxy;

        this._optBeExists = (param) => {
            if (!this.optionalBehaviors[param]) {
                this.log('error', "Attempted to check for undeclared optional behavior in " + param);
                return null;
            }
            return opt.beExists(this.param(param), this.optionalBehaviors[param]);
        }
        
        return true;
    }

    get hasInitialized() {
        return this._hasInitialized;
    }

    setHasInitialized() {
        this._hasInitialized = true;
    }
    

    /* Miscellaneous helpers */

    
    //Shortcut for obtaining the path where datafiles should be stored.
    dataPath() {
        return this.config["paths"]?.["data"];
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

    
    makeHexColor(color) {
        if (Array.isArray(color)) {
            return "#" + color.map(element => element.toString(16).padStart(2, '0')).join("");
        } else if (color) {
            return '#' + color.toString(16).padStart(6, '0')
        } else {
            return '#000000';
        }
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
                    reject({error: "Request failed: " + res.statusCode, statusCode: res.statusCode});
                } else {
                    let body = '';
                    if (options?.buffer) body = Buffer.from(body);
                    res.on('data', (chunk) => options?.buffer ? body = Buffer.concat([body, chunk]) : body += chunk);
                    res.on('end', () => {
                        if (options?.returnFull) {
                            resolve({body: body, cookies: res.headers["set-cookie"], statusCode: 200});
                        } else {
                            resolve(body);
                        }
                    });
                }
            };
            
            if (url.match(/^https/i)) {
                req = https.get(url, options, callback);
            } else {
                req = http.get(url, options, callback);
            }
            req.on('error', options?.returnFull ? (e) => reject({error: e}) : reject);
        });
    }

    async urlpost(url, content, options, encoding) {
        if (!encoding && typeof options == "string") {
            encoding = options;
            options = undefined;
        }
        if (!options) options = {};

        let headers = {};
        if (!content) {
            content = "";
        } else {
            if (typeof content == "object") {
                content = querystring.stringify(content);
                headers["Content-Type"] = "application/x-www-form-urlencoded";
            }
            headers["Content-Length"] = Buffer.byteLength(content);
        }

        headers = Object.assign(headers, options.headers);
        options = Object.assign({method: 'POST'}, options);
        options.headers = headers;

        return new Promise((resolve, reject) => {
            let req;

            let callback = (res) => {
                if (encoding) {
                    res.setEncoding(encoding);
                }
                if (res.statusCode !== 200) {
                    reject({error: "Request failed: " + res.statusCode, statusCode: res.statusCode, content: content, headers: headers});
                } else {
                    let body = '';
                    if (options?.buffer) body = Buffer.from(body);
                    res.on('data', (chunk) => options?.buffer ? body = Buffer.concat([body, Buffer.from(chunk)]) : body += chunk);
                    res.on('end', () => {
                        if (options?.returnFull) {
                            resolve({body: body, cookies: res.headers["set-cookie"], statusCode: 200});
                        } else {
                            resolve(body);
                        }
                    });
                }
            };
            
            if (url.match(/^https/i)) {
                req = https.request(url, options, callback);
            } else {
                req = http.request(url, options, callback);
            }
            req.on('error', options?.returnFull ? (e) => reject({error: e}) : reject);
            req.write(content);
            req.end();
        });
    }
    
    //Returns Promise of object from JSON pointed at by URL
    async jsonget(url, options) {
        let body = await this.urlget(url, options, 'utf8');
        if (typeof body == "object") body.body = JSON.parse(body.body);
        else body = JSON.parse(body);
        return body;
    }

    async jsonpost(url, content, options) {
        let headers = {"Content-type": "application/json"};
        headers = Object.assign(headers, options.headers);
        options.headers = headers;
        let body = await this.urlpost(url, content ? JSON.stringify(content) : null, options, 'utf8');
        if (typeof body == "object") body.body = JSON.parse(body.body);
        else body = JSON.parse(body);
        return body;
    }
    
    //Returns stream of URL contents
    streamget(url, options, extcallback) {
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
