/* Module: DynamicConfig -- Dynamically manipulate module configuration files. */

const Module = require('../Module.js');
const random = require('meteor-random');

const PERM_ADMIN = 'administrator';

class ModDynamicConfig extends Module {


    get optionalParams() { return [
        'envs',                 //List of allowed environments
        'pathseparator'         //Path separator for config file entry key references
    ]; }

    get isRootAccess() { return true; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('DynamicConfig', name);
        
        this._params['envs'] = null;
        this._params['pathseparator'] = '/';
    }

    initialize(opt) {
        if (!super.initialize(opt)) return false;


        this.mod('Commands').registerRootDetails(this, 'cfg', {
            description: "Read or write a module's parameters dynamically.",
            details: [
                "This command allows an administrator to modify the contents of module config files.",
                "Changes will not apply automatically. You must use the reload command or restart the bot manually.",
                "This command can't be used to add/remove modules or to manipulate environments.",
                "MODULE names are case sensitive. Parameter PATHs are nested JSON object keys separated by periods."
            ]
        });


        this.mod("Commands").registerCommand(this, 'cfg params', {
            description: "Lists a module's parameters.",
            details: [
                "Underlined parameters are required.",
                "If the current live value for a parameter is different from the one in the config file, it will be displayed between parenthesis."
            ],
            args: ["module", "filter"],
            minArgs: 1,
            types: ["private"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let modules = this.mod('root').getAllModules();
            if (!modules[args.module]) {
                ep.reply("Module not found.");
                return true;
            }

            let re = null;
            if (args.filter) {
                if (!args.filter.match(/^[A-Za-z09-9*\.]+$/)) {
                    ep.reply("The filter can only contain letters and numbers, . and * for matching any.");
                    return true;
                } else {
                    re = new RegExp("^" + args.filter.replace(/\*/g, ".*") + "$", "i");
                }
            }

            let target = modules[args.module];
            let conf = this.loadData(target.configfile, {}, {abspath: true});

            let display = [];

            let makedisplay = (required) => (param) => {

                let val = conf[param];
                if (Array.isArray(val)) val = "[List]";
                else if (typeof val == "object") val = "[Map]";
                else if (val === undefined) val = "[Unset]";

                let current = target.param(param);
                if (Array.isArray(current)) current = "[List]";
                else if (typeof current == "object") current = "[Map]";
                else if (current === undefined) current = "[Unset]";
                
                return {
                    name: param,
                    value: val,
                    current: current,
                    required: required
                };
            };

            display = display.concat(target.requiredParams.map(makedisplay(true)));
            display = display.concat(target.optionalParams.map(makedisplay(false)));

            if (re) display = display.filter((item) => re.exec(item.name));

            display.sort((a, b) => a.name.localeCompare(b.name));

            if (!display.length) {
                ep.reply("There are no parameters.");
            } else {
                for (let item of display) {
                    let out = "**" + item.name + "**";
                    if (item.required) out = "__" + out + "__";
                    out += ": " + item.value;
                    if (item.value != item.current) {
                        out += " (Current: " + item.current + ")";
                    }
                    ep.reply(out);
                }
            }

            return true;
        });


        this.mod("Commands").registerCommand(this, 'cfg get', {
            description: "Shows the value of a parameter on a configuration file.",
            args: ["module", "path"],
            types: ["private"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let modules = this.mod('root').getAllModules();
            if (!modules[args.module]) {
                ep.reply("Module not found.");
                return true;
            }

            let target = modules[args.module];
            let conf = this.loadData(target.configfile, {}, {abspath: true});

            let val = this.resolvePath(conf, args.path);

            if (val === undefined) {
                let current = this.resolvePath(target.params, args.path);
                if (!current) {
                    ep.reply("Value not set or path not found.");
                } else {
                    ep.reply("Value not set. Current:");
                    if (env.envName == "Discord") ep.reply("```js");
                    ep.reply(JSON.stringify(current, null, "    "));
                    if (env.envName == "Discord") ep.reply("```");
                }
            } else {
                if (env.envName == "Discord") ep.reply("```js");
                ep.reply(JSON.stringify(val, null, "    "));
                if (env.envName == "Discord") ep.reply("```");
            }

            return true;
        });


        this.mod("Commands").registerCommand(this, 'cfg set', {
            description: "Modifies the value of a parameter on a configuration file.",
            args: ["module", "path", "value", true],
            types: ["private"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let modules = this.mod('root').getAllModules();
            if (!modules[args.module]) {
                ep.reply("Module not found.");
                return true;
            }

            let target = modules[args.module];
            let conf = this.loadData(target.configfile, {}, {abspath: true, pretty: true});

            let container = this.resolvePath(conf, args.path, true);
            if (container === undefined) {
                ep.reply("Path of container not found.");
                return true;
            }

            let key = args.path.substring(args.path.lastIndexOf(this.param("pathseparator")) + 1);
            if (key == args.path && target.requiredParams.indexOf(key) < 0 && target.optionalParams.indexOf(key) < 0) {
                ep.reply("This module doesn't have a parameter with this name. Use cfg params for a list of parameters.");
                return true;
            }

            let value = args.value.join(" ").replace(/'/g, '"');
            try {
                value = JSON.parse(value);
            } catch (e) {}

            container[key] = value;

            conf.save();

            ep.reply("Set value of " + args.path + ".");

            return true;
        });


        this.mod("Commands").registerCommand(this, 'cfg unset', {
            description: "Deletes the value of a parameter from a configuration file.",
            args: ["module", "path"],
            types: ["private"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let modules = this.mod('root').getAllModules();
            if (!modules[args.module]) {
                ep.reply("Module not found.");
                return true;
            }

            let target = modules[args.module];
            let conf = this.loadData(target.configfile, {}, {abspath: true, pretty: true});

            let container = this.resolvePath(conf, args.path, true);
            if (container === undefined) {
                ep.reply("Path of container not found.");
                return true;
            }

            let key = args.path.substring(args.path.lastIndexOf(this.param("pathseparator")) + 1);
            if (key == args.path && target.requiredParams.indexOf(key) >= 0) {
                ep.reply("This is a required parameter. To replace its valuem use cfg set.");
                return true;
            }

            if (container[key] !== undefined) delete container[key];

            conf.save();

            ep.reply("Unset value of " + args.path + ".");

            return true;
        });


        this.mod("Commands").registerCommand(this, 'cfg add', {
            description: "Adds a value to a list on a configuration file.",
            args: ["module", "path", "value", true],
            types: ["private"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let modules = this.mod('root').getAllModules();
            if (!modules[args.module]) {
                ep.reply("Module not found.");
                return true;
            }

            let target = modules[args.module];
            let conf = this.loadData(target.configfile, {}, {abspath: true, pretty: true});

            let container = this.resolvePath(conf, args.path, true);
            if (container === undefined) {
                ep.reply("Path of container not found.");
                return true;
            }

            let key = args.path.substring(args.path.lastIndexOf(this.param("pathseparator")) + 1);

            if (container[key] === undefined) {
                container[key] = [];
            } else if (!Array.isArray(container[key])) {
                ep.reply("This path does not reference a list.");
                return true;
            }

            let value = args.value.join(" ").replace(/'/g, '"');
            try {
                value = JSON.parse(value);
            } catch (e) {}

            container[key].push(value);

            conf.save();

            ep.reply("Added value to " + args.path + ".");

            return true;
        });

        this.mod("Commands").registerCommand(this, 'cfg del', {
            description: "Removes a value from a list on a configuration file.",
            args: ["module", "path", "value", true],
            types: ["private"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let modules = this.mod('root').getAllModules();
            if (!modules[args.module]) {
                ep.reply("Module not found.");
                return true;
            }

            let target = modules[args.module];
            let conf = this.loadData(target.configfile, {}, {abspath: true, pretty: true});

            let container = this.resolvePath(conf, args.path, true);
            if (container === undefined) {
                ep.reply("Path of container not found.");
                return true;
            }

            let key = args.path.substring(args.path.lastIndexOf(this.param("pathseparator")) + 1);

            if (!Array.isArray(container[key])) {
                ep.reply("This path does not reference a list.");
                return true;
            }

            let value = args.value.join(" ").replace(/'/g, '"');
            try {
                value = JSON.parse(value);
            } catch (e) {}
            
            let ind = container[key].indexOf(value);
            if (ind < 0) {
                ep.reply("Value not found in list.");
                return true;
            }

            container[key].splice(ind, 1);

            conf.save();

            ep.reply("Removed value from " + args.path + ".");

            return true;
        });


        return true;
    }


    // # Module code below this line #

    resolvePath(object, path, parent) {
        let location = object;
        let tracks = path.split(this.param("pathseparator"));

        if (parent) {
            if (!tracks.length) return undefined;
            tracks = tracks.slice(0, -1);
        }

        let track;
        while (track = tracks.shift()) {
            if (typeof(location) != "object") break;
            location = location[track];
        }

        return location;
    }

}

module.exports = ModDynamicConfig;