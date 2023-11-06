import path from 'path';
import url from 'url';
import fs from 'fs';

import logger from './Logger.js';
import config from './Config.js';

const PATH_BEHAVIORS = "./behavior/";
const PATH_ENVIRONMENTS = "./environment/";
const ENVIRONMENT_PREFIX = "Env";

//Dynamic import wrapper that refreshes cached modules
export async function importUncached(modulepath) {
    const filepath = path.resolve(modulepath);
    const ext = path.extname(filepath);
    const newFilepath = `${filepath.replace(new RegExp(`\\${ext}$`), "")}.${Date.now()}${ext}`;
    const fileurl = url.pathToFileURL(newFilepath);
    
    try {
        const fileContent = await fs.promises.readFile(filepath, "utf8");
        await fs.promises.writeFile(newFilepath, fileContent);
    } catch (e) {
        return;
    }
    
    try {
        const module = await import(fileurl);
        return module;
    } finally {
        fs.unlink(newFilepath, () => {});
    }
}


//Core module, responsible for managing environments and behaviors

export default class Core {

    constructor() {

        //Master map of environment instances
        this._environments = {};

        //Master map of behavior instances
        this._behaviors = {};

        //Keeps track of delayed cross-behavior requests (due to unavailable behaviors)
        this._behaviordelayed = {};

        //Map of shared environment dependencies
        this._shared = {};

        //Graceful shutdown handlers
        this._shutdown = [];
        this._shuttingDown = [];
        
        //Cleanup handlers
        this._cleanup = [];

    }


    //Methods for behaviors with core access

    resetContext() {
        this._environments = {};
        this._behaviors = {};
        this._behaviordelayed = {};
        this._shared = {};
        this._shutdown = [];
        this._cleanup = [];
    }

    getAllEnvironments() {
        return this._environments;
    }
    
    getAllBehaviors() {
        return this._behaviors;
    }


    //Store and execute delayed cross-behavior requests

    behaviorDelay(behavior, callback) {
        if (!behavior?.name || typeof callback !== "function") return false;
        if (!this._behaviordelayed[behavior.name]) {
            this._behaviordelayed[behavior.name] = [];
        }
        this._behaviordelayed[behavior.name].push(callback);
        return true;
    }
    
    behaviorExecuteDelayed(name) {
        if (!this._behaviordelayed[name]) return;
        for (let callback of this._behaviordelayed[name]) {
            callback();
        }
        delete this._behaviordelayed[name];
    }
    

    //Method for behaviors to register a shutdown or cleanup handler
    //Shutdown handlers run if the process is interrupted and can abort by not calling the next handler
    //Cleanup handlers run synchronously while the process exits and cannot abort

    pushShutdownHandler(func) {
        if (typeof func != "function") return false;
        this._cleanup.push(func);
        return true;        
    }

    pushCleanupHandler(func) {
        if (typeof func != "function") return false;
        this._cleanup.push(func);
        return true;
    }

    nextShutdown() {
        let oneshutdown = this._shuttingDown.shift();
        if (oneshutdown) oneshutdown(this.nextShutdown.bind(this));
        else process.exit();
    }

    nextCleanup() {
        let onecleanup = this._cleaningUp.shift();
        if (onecleanup) this._exitCode = onecleanup(this.nextCleanup.bind(this)) || 0;
        else process.exit(this._exitCode);
    }

    beginShutdown() {
        this._shuttingDown = this._shutdown.slice();
        this.nextShutdown.apply(this);
    }

    performCleanup() {
        let cleaningUp = this._cleanup;
        if ((process.exitCode || 0) != 0) {
            cleaningUp.push(() => {
                for (let item of logger.tail(5)) {
                    console.log(`[${item.level.toUpperCase()}] ${item.message}`);
                }
            });
        }
        for (let func of cleaningUp) {
            func();
        }
    }


    //Proxy factory that creates an interface for modules to call each other asynchronously.

    createLocalProxyForModule(label, targetMap, proxyMap, trap) {
        return function(name) {
            name = name || null;
            if (name && !targetMap[name]) {
                logger.error("Requested proxy for unknown " + label + " instance: " + name);
                return;
            }
            if (!proxyMap[name]) {
                proxyMap[name] = new Proxy(name ? targetMap[name] : {}, {
                    get: (target, prop) => {
                        if (prop[0] === "_") return undefined;
                        if (name) {
                            //Specific target
                            let member = Reflect.get(target, prop);
                            if (typeof member !== "function" || target.synchronousMethods?.find(s => s === prop)) {
                                return member;
                            }
                            return async (...methodArgs) => trap(targetMap[name], member, methodArgs);
                        } else {
                            //Every target - can only be used for methods
                            return (...methodArgs) => {
                                let promises = [];
                                for (let targetName in targetMap) {
                                    let target = targetMap[targetName];
                                    let member = Reflect.get(target, prop);
                                    if (target.synchronousMethods?.find(s => s === prop)) continue;
                                    promises.push((async () => trap(target, member, methodArgs))());
                                }
                                return Promise.allSettled(promises);
                            }
                        }
                    }
                });
            }
            return proxyMap[name];
        }
    }
    
    createEnvironmentProxy() {
        var proxiedEnvironments = {};
        return this.createLocalProxyForModule("environment", this._environments, proxiedEnvironments, (target, method, args) => {
            return method.apply(target, args);
        });
    }
    
    createBehaviorProxy() {
        var proxiedBehaviors = {};
        return this.createLocalProxyForModule("behavior", this._behaviors, proxiedBehaviors, (target, method, args) => {
            if (target.hasInitialized) {
                return method.apply(target, args);
            } else {
                return new Promise((resolve, reject) => {
                    this.behaviorDelay(target, () => resolve(method.apply(target, args)));
                });
            }
        });
    }


    //Load and initialize configured environments

    async listEnvironmentTypes() {
        let files = await fs.promises.readdir(PATH_ENVIRONMENTS);
        return files.filter(file => file.startsWith(ENVIRONMENT_PREFIX)).map(file => {
            let match = file.match(new RegExp(ENVIRONMENT_PREFIX + "(.+)\\.js"));
            return match[1];
        });
    }

    async createEnvironment(type, name, logerror) {
        let envtype = await importUncached(PATH_ENVIRONMENTS + ENVIRONMENT_PREFIX + type + ".js");
        envtype = envtype?.default;
        if (!envtype) {
            if (logerror) logger.error("Could not load the environment: " + name + " . Is the environment source in in the environment directory?");
            return null;
        }
        return new envtype(name);
    }

    async loadEnvironments() {

        if (Object.keys(config?.environments || {}).length < 1) {
            logger.warn("Environments provide connectivity. You should configure at least one Environment.");
            return true;
        }

        for (let name in config.environments) {

            let env = await this.createEnvironment(config.environments[name].type, name, true);
            if (!env) return false;
            
            let sharedInstances = {};
            for (let sharedModule of env.sharedModules) {
                let sharedName = env.type + '_' + sharedModule;
                
                if (!this._shared[sharedName]) {
                    this._shared[sharedName] = await importUncached(PATH_ENVIRONMENTS + sharedModule + ".js");
                    this._shared[sharedName] = this._shared[sharedName]?.default;
                    if (!this._shared[sharedName]) {
                        logger.error("Could not initialize the environment: " + name + " . The shared module " + sharedModule + " could not be found.");
                        return false;
                    }
                }
                
                sharedInstances[sharedModule] = this._shared[sharedName];
            }
            
            try {
                if (!env.initialize({
                    config: config,
                    sharedInstances: sharedInstances,
                    pushShutdownHandler: this.pushShutdownHandler.bind(this),
                    pushCleanupHandler: this.pushCleanupHandler.bind(this)
                })) {
                    logger.error("Could not initialize the environment: " + name + " . Usually this means one or more required parameters are missing. Please make sure all the required parameters are defined.");
                    return false;
                }
            } catch (e) {
                logger.error("Exception when initializing the environment: " + name + ". " + e);
                return false;
            }
            
            env.on('error', (err) => {
                logger.warn("[" + env.name + "] Error: " + err);
            });
            this._environments[env.name] = env;
            
            logger.info("Successfully loaded and initialized environment: " + env.name);
        }
        
        return true;
    }


    //Load and initialize configured behaviors

    async listBehaviorTypes() {
        let files = await fs.promises.readdir(PATH_BEHAVIORS);
        return files.map(file => {
            let match = file.match("(.+)\\.js");
            return match[1];
        });
    }

    async createBehavior(type, name, logerror) {
        let betype = await importUncached(PATH_BEHAVIORS + type + ".js");
        betype = betype?.default;
        if (!betype) {
            if (logerror) logger.error("Could not load the behavior: " + name + " . Is the behavior source in the behavior directory?");
            return null;
        }
        return new betype(name);
    }

    async loadBehaviors() {

        if ((config?.behaviors?.length || 0) < 1) {
            logger.warn("Behaviors provide functionality. You should configure at least one Behavior.");
            return true;
        }

        let uniqueBehaviors = {};

        //First pass: Instantiate and store all behaviors

        for (let beConfig of config.behaviors) {
            
            let be = await this.createBehavior(beConfig.type, beConfig.name);
            if (!be) return false;

            if (!be.isMultiInstanceable) {
                if (uniqueBehaviors[be.type]) {
                    logger.error("Could not load the behavior: " + beConfig.name + " . This behavior is not multi-instanceable and there already exists an instance named " + uniqueBehaviors[be.type].name);
                    return false;
                }
                uniqueBehaviors[be.type] = be;
            }

            this._behaviors[be.name] = be;

            logger.info("Successfully instantiated behavior: " + be.name + (be.name != be.type ? " (" + be.type + ")" : ""));
        }

        //Second pass: Initialize all behaviors

        for (let beConfig of config.behaviors) {
            
            let be = this._behaviors[beConfig.name];

            let core;
            if (be.isCoreAccess) {
                logger.info("The behavior: " + be.name + " requested access to the core module.");
                core = this;
            }

            try {
                if (!be.initialize({
                    config: config,
                    envExists: (name, type) => type ? this._environments[name]?.type === type : !!this._environments[name],
                    beExists: (name, type) => type ? this._behaviors[name]?.type === type : !!this._behaviors[name],
                    envProxy: this.createEnvironmentProxy(),
                    beProxy: this.createBehaviorProxy(),
                    pushShutdownHandler: this.pushShutdownHandler.bind(this),
                    pushCleanupHandler: this.pushCleanupHandler.bind(this),
                    rootpath: path.resolve(),
                    core: core
                })) {
                    logger.error("Could not initialize the behavior: " + be.name + " . Usually this means one or more required parameters are missing. Please make sure all the required parameters are defined and valid.");
                    return false;
                }
            } catch (e) {
                logger.error("Exception when initializing the behavior: " + be.name + ". " + e);
                return false;
            }

            be.setHasInitialized();
            logger.info("Successfully initialized behavior: " + be.name + (be.name != be.type ? " (" + be.type + ")" : ""));

            this.behaviorExecuteDelayed(be.name);
            
        }
        
        return true;
    }


    //Run and stop environments

    async stopEnvironments() {
        let promises = [];
        for (let name in this._environments) {
            logger.info("Requesting disconnection of environment " + name + " ...");
            let prom = this._environments[name].disconnect();
            prom.catch((e) => {
                logger.error("Exception disconnecting from environment " + name + ": " + e);
            });
            promises.push(prom);
        }
        return Promise.allSettled(promises).catch(() => {});
    }

    async runEnvironments() {
        let promises = [];
        for (let name in this._environments) {
            logger.info("Requesting connection of environment " + name + " ...");
            let prom = this._environments[name].connect();
            prom.catch((e) => {
                logger.error("Exception connecting to environment " + name + ": " + e);
            });
            promises.push(prom);
        }
        return Promise.all(promises).catch(() => {});
    }

}
