//Wrapper around the config file for destructive config manipulation operations.

import yaml from 'yaml';

const COMMENT_TOP = "This is the master configuration file. Declare here your environments (which connect to other systems) and behaviors (which provide functionality).";
const COMMENT_PATHS = "Filesystem paths used by the core.";
const COMMENT_ENVS = "Environment declaration mapping each instance name to a map of options. The options can be 'type' and parameters specific to that environment type. Multiple environments of the same type are permitted.";
const COMMENT_BECOMMON = "Common options that will be replicated to every loaded behavior.";
const COMMENT_BES = "Behavior declaration consisting in a list of behaviors in load order. For each item provide a string (which will be used as the 'type') or a map containing 'type', optionally 'name', and parameters specific to that behavior type.";

const HEADER_PATHS = "paths";
const HEADER_ENVIRONMENTS = "environments";
const HEADER_BECOMMON = "behaviorCommon";
const HEADER_BEHAVIORS = "behaviors";

const KEY_TYPE = "type";
const KEY_NAME = "name";

export const ConfigFail = {
    CONFIG_NOT_FOUND: 1,
    TYPE_NOT_FOUND: 2,
    PARAM_NOT_FOUND: 3
};

export default class EditConfig {

    document = null;
    core = null;

    #envCache = {};
    #beCache = {};

    constructor(data) {
        this.document = yaml.parseDocument(data);
        this.setup();
    }

    toString() {
        return this.document ? yaml.stringify(this.document) : "";
    }

    setup() {

        if (!this.document.commentBefore) {
            this.document.commentBefore = COMMENT_TOP;
        }

        let nodePaths = this.document.get(HEADER_PATHS, true);
        if (nodePaths === undefined) {
            nodePaths = this.document.createNode({
                logger: "[logs/]Y-MM[.log]",
                data: "data/"
            });
        }
        if (!nodePaths.commentBefore) {
            nodePaths.commentBefore = COMMENT_PATHS;
        }
        this.document.set(HEADER_PATHS, nodePaths);

        let nodeEnvs = this.document.get(HEADER_ENVIRONMENTS, true);
        if (nodeEnvs === undefined) {
            nodeEnvs = this.document.createNode({MyDiscord: {type: "Discord"}});
        }
        if (!nodeEnvs.commentBefore) {
            nodeEnvs.commentBefore = COMMENT_ENVS;
        }
        this.document.set(HEADER_ENVIRONMENTS, nodeEnvs);

        let nodeBeCommons = this.document.get(HEADER_BECOMMON, true);
        if (nodeBeCommons === undefined) {
            nodeBeCommons = this.document.createNode({Discord: "MyDiscord", Commands: "Commands"});
        }
        if (!nodeBeCommons.commentBefore) {
            nodeBeCommons.commentBefore = COMMENT_BECOMMON;
        }
        this.document.set(HEADER_BECOMMON, nodeBeCommons);

        let nodeBes = this.document.get(HEADER_BEHAVIORS, true);
        if (nodeBes === undefined) {
            nodeBes = this.document.createNode(["Users", "Commands"]);
        }
        if (!nodeBes.commentBefore) {
            nodeBes.commentBefore = COMMENT_BES;
        }
        this.document.set(HEADER_BEHAVIORS, nodeBes);

    }


    //Manipulate environments


    #getEnvironment(name) {
        let nodeEnvs = this.document.get(HEADER_ENVIRONMENTS, true);
        return nodeEnvs?.get(name, true);
    }

    addEnvironment(name, type) {
        let nodeEnv = this.#getEnvironment(name);
        if (nodeEnv) {
            nodeEnv.set(KEY_TYPE, type);
            return nodeEnv;
        }
        nodeEnv = this.document.createNode({type: type})
        this.document.setIn([HEADER_ENVIRONMENTS, name], nodeEnv);
        return nodeEnv;
    }

    removeEnvironment(name) {
        return this.document.deleteIn([HEADER_ENVIRONMENTS, name]);
    }


    //Manipulate behaviors


    #getBehavior(name, returnIndex) {
        let nodeBes = this.document.get(HEADER_BEHAVIORS, true);
        return nodeBes?.items[returnIndex ? "findIndex" : "find"](behavior => {
            //Plain string
            if (yaml.isScalar(behavior) && behavior.value === name) return true;
            if (!yaml.isMap(behavior)) return false;
            //Map with explicit name
            let bename = behavior.items.find(param => yaml.isPair(param) && param.key.value == KEY_NAME);
            if (bename && bename.value.value === name) return true;
            if (!bename) {
                //Map with type
                let betype = behavior.items.find(param => yaml.isPair(param) && param.key.value == KEY_TYPE);
                if (betype && betype.value.value === name) return true;
            }
            return false;
        });
    }

    addBehavior(name, type, pos) {
        if (!name) return;
        let nodeBe = this.#getBehavior(name);
        if (nodeBe) {
            if (pos !== undefined) {
                this.#insertBehavior(nodeBe, pos, this.#getBehavior(name, true));
            }
            if (yaml.isScalar(nodeBe)) {
                if (!type || name === type) return nodeBe;
                //Upgrade scalar to map
                let indexBe = this.#getBehavior(name, true);
                nodeBe = this.document.createNode({name, type});
                this.document.setIn([HEADER_BEHAVIORS, indexBe], nodeBe);
            } else if (type) {
                //Keep map, update type
                nodeBe.set(KEY_TYPE, type);
                return nodeBe;
            }
        } else {
            //New scalar or map
            if (!type || name === type) {
                nodeBe = this.document.createNode(name);
            } else {
                nodeBe = this.document.createNode({name, type});
            }
            if (pos !== undefined) {
                this.#insertBehavior(nodeBe, pos);
            } else {
                this.document.addIn([HEADER_BEHAVIORS], nodeBe);
            }
            return nodeBe;
        }
    }

    #insertBehavior(nodeBe, pos, removeOld) {
        let nodeBes = this.document.get(HEADER_BEHAVIORS, true);
        if (removeOld) {
            nodeBes.items.splice(removeOld, 1);
        }
        nodeBes.items.splice(pos, 0, nodeBe);
    }

    insertBehaviorBefore(name, type, before) {
        let indexBefore = before ? this.#getBehavior(before, true) : 0;
        if (indexBefore < 0) return null;
        return this.addBehavior(name, type, indexBefore);
    }

    removeBehavior(name) {
        let indexBe = this.#getBehavior(name, true);
        if (indexBe > -1) {
            return this.document.deleteIn([HEADER_BEHAVIORS, indexBe]);
        }
        return false;
    }


    //Write environment parameters


    async #getEnvironmentInstance(name, type) {
        if (this.#envCache[name]) return this.#envCache[name];
        if (!type || !this.core) return null;
        this.#envCache[name] = await this.core.createEnvironment(type, name);
        return this.#envCache[name];
    }

    async setEnvironmentParameter(name, key, value) {
        let nodeEnv = this.#getEnvironment(name);
        if (!nodeEnv) return ConfigFail.CONFIG_NOT_FOUND;
        let env = await this.#getEnvironmentInstance(name, nodeEnv.get(KEY_TYPE));
        if (!env) return ConfigFail.TYPE_NOT_FOUND;
        let descriptor = env.params.find(param => param.n === key);
        if (!descriptor) return ConfigFail.PARAM_NOT_FOUND;
        nodeEnv.set(key, this.document.createNode(value));
    }

    async addEnvironmentParameters(name, {required, missing}) {
        let nodeEnv = this.#getEnvironment(name);
        if (!nodeEnv) return ConfigFail.CONFIG_NOT_FOUND;
        let env = await this.#getEnvironmentInstance(name, nodeEnv.get(KEY_TYPE));
        if (!env) return ConfigFail.TYPE_NOT_FOUND;
        
        for (let {n} of env.params) {
            if (required && env.defaults[n] !== undefined) continue;
            if (missing && nodeEnv.get(n) !== undefined) continue;
            await this.setEnvironmentParameter(name, n, env.defaults[n] || null);
        }
    }


    //Clear environment parameters


    removeEnvironmentParameter(name, key) {
        let nodeEnv = this.#getEnvironment(name);
        if (!nodeEnv) return ConfigFail.CONFIG_NOT_FOUND;
        return nodeEnv.delete(key);
    }

    clearEnvironmentParameters(name) {
        let nodeEnv = this.#getEnvironment(name);
        if (!nodeEnv) return ConfigFail.CONFIG_NOT_FOUND;
        let type = nodeEnv.get(KEY_TYPE);
        nodeEnv.items = [];
        if (type) nodeEnv.set(KEY_TYPE, type);
    }


    //Behavior common


    setBehaviorCommonParameter(key, value) {
        this.document.setIn([HEADER_BECOMMON, key], value);
    }

    removeBehaviorCommonParameter(key) {
        return this.document.deleteIn([HEADER_BECOMMON, key]);
    }

    clearBehaviorCommonParameters() {
        let nodeBeCommons = this.document.get(HEADER_BECOMMON, true);
        if (!nodeBeCommons) return;
        nodeBeCommons.items = [];
    }


    //Write behavior parameters


    async getBehaviorInstance(name, type) {
        if (this.#beCache[name]) return this.#beCache[name];
        if (!type || !this.core) return null;
        this.#beCache[name] = await this.core.createBehavior(type, name);
        return this.#beCache[name];
    }

    async #getBehaviorInstanceFromNode(nodeBe) {
        if (!nodeBe || !yaml.isNode(nodeBe)) return;
        if (yaml.isScalar(nodeBe)) {
            return this.getBehaviorInstance(nodeBe.value, nodeBe.value);
        } else if (!nodeBe.get(KEY_NAME)) {
            return this.getBehaviorInstance(nodeBe.get(KEY_TYPE), nodeBe.get(KEY_TYPE));
        } else {
            return this.getBehaviorInstance(nodeBe.get(KEY_NAME), nodeBe.get(KEY_TYPE));
        }
    }

    async setBehaviorParameter(name, key, value) {
        let nodeBe = this.#getBehavior(name);
        if (!nodeBe) return ConfigFail.CONFIG_NOT_FOUND;
        let be = await this.#getBehaviorInstanceFromNode(nodeBe);
        if (!be) return ConfigFail.TYPE_NOT_FOUND;
        let descriptor = be.params.find(param => param.n === key);
        if (!descriptor) return ConfigFail.PARAM_NOT_FOUND;

        if (yaml.isScalar(nodeBe)) {
            //Upgrade scalar to map
            let indexBe = this.#getBehavior(name, true);
            nodeBe = this.document.createNode({type: name});
            nodeBe.spaceBefore = true;
            this.document.setIn([HEADER_BEHAVIORS, indexBe], nodeBe);
        }

        nodeBe.set(key, this.document.createNode(value));
    }

    async addBehaviorParameters(name, {required, missing}) {
        let nodeBe = this.#getBehavior(name);
        if (!nodeBe) return ConfigFail.CONFIG_NOT_FOUND;
        let be = await this.#getBehaviorInstanceFromNode(nodeBe);
        if (!be) return ConfigFail.TYPE_NOT_FOUND;
        
        for (let {n} of be.params) {
            if (required && be.defaults[n] !== undefined) continue;
            if (missing && yaml.isCollection(nodeBe) && nodeBe.get(n) !== undefined) continue;
            await this.setBehaviorParameter(name, n, be.defaults[n] || null);
        }
    }


    //Clear behavior parameters


    removeBehaviorParameter(name, key) {
        let nodeBe = this.#getBehavior(name);
        if (!nodeBe) return ConfigFail.CONFIG_NOT_FOUND;
        return nodeBe.delete(key);
    }

    clearBehaviorParameters(name) {
        let nodeBe = this.#getBehavior(name);
        if (!nodeBe) return ConfigFail.CONFIG_NOT_FOUND;
        if (yaml.isScalar(nodeBe)) return;
        let betype = nodeBe.get(KEY_TYPE);
        let bename = nodeBe.get(KEY_NAME);
        nodeBe.items = [];
        if (betype) nodeBe.set(KEY_TYPE, betype);
        if (bename) nodeBe.set(KEY_NAME, bename);
    }


    //Manipulate comments


    async addEnvironmentComments(name, {header, params, unset}) {
        let nodeEnv = this.#getEnvironment(name);
        if (!nodeEnv) return ConfigFail.CONFIG_NOT_FOUND;
        let env = await this.#getEnvironmentInstance(name, nodeEnv.get(KEY_TYPE));
        if (!env) return ConfigFail.TYPE_NOT_FOUND;

        if (header) {
            let currentComment = (nodeEnv.commentBefore || "").trim();
            if (!unset && currentComment !== env.description || unset && !currentComment) {
                nodeEnv.commentBefore = env.description;
            }
        }

        if (params) {
            for (let {n, d} of env.params) {
                if (Array.isArray(params) && !params.includes(n)) continue;
                let nodeParam = nodeEnv.get(n, true);
                if (!nodeParam) continue;
                let currentComment = (nodeParam.commentBefore || "").trim();
                if (!unset && currentComment !== d || unset && !currentComment) {
                    nodeParam.comment = d;
                }
            }
        }

    }

    async removeEnvironmentComments(name, {header, params, exact}) {
        let nodeEnv = this.#getEnvironment(name);
        if (!nodeEnv) return ConfigFail.CONFIG_NOT_FOUND;
        let env = await this.#getEnvironmentInstance(name, nodeEnv.get(KEY_TYPE));
        if (!env) return ConfigFail.TYPE_NOT_FOUND;

        if (header) {
            let currentComment = (nodeEnv.commentBefore || "").trim();
            if (!exact && currentComment || exact && currentComment !== env.description) {
                nodeEnv.commentBefore = undefined;
            }
        }
        
        if (params) {
            for (let {n, d} of env.params) {
                if (Array.isArray(params) && !params.includes(n)) continue;
                let nodeParam = nodeEnv.get(n, true);
                let currentComment = (nodeParam.commentBefore || "").trim();
                if (!exact && currentComment|| exact && currentComment !== d) {
                    nodeParam.comment = undefined;
                }
            }
        }

    }


    async addBehaviorComments(name, {header, params, unset}) {
        let nodeBe = this.#getBehavior(name);
        if (!nodeBe) return ConfigFail.CONFIG_NOT_FOUND;
        let be = await this.#getBehaviorInstanceFromNode(nodeBe);
        if (!be) return ConfigFail.TYPE_NOT_FOUND;

        if (header) {
            let currentComment = (nodeBe.commentBefore || "").trim();
            if (!unset && currentComment !== be.description || unset && !currentComment) {
                nodeBe.commentBefore = be.description;
            }
        }

        if (params && yaml.isCollection(nodeBe)) {
            for (let {n, d} of be.params) {
                if (Array.isArray(params) && !params.includes(n)) continue;
                let nodeParam = nodeBe.get(n, true);
                if (!nodeParam) continue;
                let currentComment = (nodeParam.commentBefore || "").trim();
                if (!unset && currentComment !== d || unset && !currentComment) {
                    nodeParam.comment = d;
                }
            }
        }

    }

    async removeBehaviorComments(name, {header, params, exact}) {
        let nodeBe = this.#getBehavior(name);
        if (!nodeBe) return ConfigFail.CONFIG_NOT_FOUND;
        let be = await this.#getBehaviorInstanceFromNode(nodeBe);
        if (!be) return ConfigFail.TYPE_NOT_FOUND;

        if (header) {
            let currentComment = (nodeBe.commentBefore || "").trim();
            if (!exact && currentComment || exact && currentComment !== be.description) {
                nodeBe.commentBefore = undefined;
            }
        }

        if (params) {
            for (let {n, d} of be.params) {
                if (Array.isArray(params) && !params.includes(n)) continue;
                let nodeParam = nodeBe.get(n, true);
                let currentComment = (nodeParam.commentBefore || "").trim();
                if (!exact && currentComment|| exact && currentComment !== d) {
                    nodeParam.comment = undefined;
                }
            }
        }

    }


}
