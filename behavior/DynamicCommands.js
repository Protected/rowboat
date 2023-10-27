//WARNING: This behavior stores environment names. Renaming an environment with dynamic commands will break the stored commands.

import random from 'meteor-random';

import Behavior from '../src/Behavior.js';

export default class DynamicCommands extends Behavior {

    get description() { return "Dynamically create and manage simple commands"; }

    get params() { return [
        {n: 'datafile', d: "Customize the name of the default data file"},
        {n: 'envs', d: "List of allowed environments for custom command usage (or null for all)"},
        {n: 'types', d: "List of allowed message types for custom command usage (or null for all)"}
    ]; }

    get defaults() { return {
        datafile: null,
        types: null,
        envs: null
    }; }

    get requiredBehaviors() { return {
        Users: 'Users',
        Commands: 'Commands'
    }; }

    constructor(name) {
        super('DynamicCommands', name);
        
        this._testIsModerator = null;

        //{COMMANDID: {name, owner: {envname, userid}, args, minArgs, description, details, reply, environments, types, permissions, calls: [{envname, userid, channelid, args: {...}}, ...]}
        this._data = {};
    }

    initialize(opt) {
        if (!super.initialize(opt)) return false;

        this._data = this.loadData();
        if (this._data === false) return false;


        for (let name in this._data) {
            if (!opt.envExists(this._data[name].owner.envname)) continue;
            this.env(this._data[name].owner.envname).whenConnected().then(() => this.registerCommandFromDynamicDescriptor(this._data[name]));
        }


        const permAdmin = this.be("Users").defaultPermAdmin;
        let testIsModerator = this._testIsModerator = (envname, userid, channelid) =>
            this.be('Users').testPermissions(envname, userid, channelid, [permAdmin]);


        this.be('Commands').registerRootDetails(this, 'cmd', {description: "Dynamically create and manage simple commands."});


        this.be("Commands").registerCommand(this, 'cmd create', {
            description: 'Creates a new custom command.',
            args: ["name", "description", true],
            minArgs: 2,
            permissions: [permAdmin]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let name = args.name.toLowerCase();

            if (!name.match(/^[a-z][a-z0-9_-]*$/i)) {
                ep.reply("Command names must only contain a-z, A-Z, 0-9, _ and - and must start with a letter.");
                return true;
            }

            if (this._data[name]) {
                if (opt.envExists(this._data[name].owner.envname)) {
                    let ownerenv = this.env(this._data[name].owner.envname);
                    let ownername;
                    if (ownerenv.name == env.name && this._data[name].owner.userid == userid) {
                        ownername = "you";
                    } else {
                        ownername = await ownerenv.idToDisplayName(this._data[name].owner.userid);
                    }
                    ep.reply("There already exists a custom command with this name, owned by " + ownername + ".");
                } else {
                    ep.reply("There already exists a custom command with this name.");
                }                
                return true;
            }

            if (await this.be("Commands").getCommand(name)) {
                ep.reply("There already exists a command with this name.");
                return true;
            }

            let descriptionlist = args.description.join(" ").split(/[\|\n]/);

            this._data[name] = {
                name: name,
                owner: {envname: env.name, userid: userid},
                args: [],
                minArgs: null,
                description: descriptionlist[0],
                details: descriptionlist.slice(1),
                reply: [],
                environments: this.param("envs") || null,
                types: null,
                permissions: null,
                calls: []
            };

            this._data.save();

            ep.reply("The command '" + name + "' was successfull created. Use cmd reply add to add a reply.");

            this.registerCommandFromDynamicDescriptor(this._data[name]);

            return true;
        });


        this.be("Commands").registerCommand(this, 'cmd owner', {
            description: 'Transfer ownership of a custom command.',
            args: ["name", "environment", "userid"],
            details: ["You can provide the minimum amount of required arguments between the command name and the list of arguments."]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let name = args.name.toLowerCase();
            let desc = this._data[name];

            if (!desc) {
                ep.reply("There is no custom command with that name.");
                return true;
            }

            if ((desc.owner.envname != env.name || desc.owner.userid != userid)
                    && !await testIsModerator(env.name, userid, channelid)) {
                ep.reply("You are not the owner of this command.");
                return true;
            }

            desc.owner.envname = args.environment;
            desc.owner.userid = args.userid;
            this._data.save();

            ep.reply("Ownership for the command '" + name + "' was successfully transferred.");

            this.registerCommandFromDynamicDescriptor(desc);

            return true;
        });


        this.be("Commands").registerCommand(this, 'cmd set args', {
            description: 'Sets the arguments for a custom command.',
            args: ["name", "args", true],
            details: ["You can provide the minimum amount of required arguments between the command name and the list of arguments."],
            minArgs: 1
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let name = args.name.toLowerCase();
            let desc = this._data[name];

            if (!desc) {
                ep.reply("There is no custom command with that name.");
                return true;
            }

            if ((desc.owner.envname != env.name || desc.owner.userid != userid)
                    && !await testIsModerator(env.name, userid, channelid)) {
                ep.reply("You are not the owner of this command.");
                return true;
            }

            let minargs = parseInt(args.args[0]);
            if (!isNaN(minargs)) {
                desc.minArgs = minargs;
                args.args = args.args.slice(1);
            } else {
                desc.minArgs = null;
            }

            desc.args = Array.from(new Set(args.args));  //Remove duplicates
            this._data.save();

            ep.reply("Arguments set for the command '" + name + "': " + desc.args.join(", "));

            this.registerCommandFromDynamicDescriptor(desc);

            return true;
        });


        this.be("Commands").registerCommand(this, 'cmd set description', {
            description: 'Changes the description of the custom command.',
            details: ["Use | to provide additional information (which will only be displayed by the help command)."],
            args: ["name", "description", true],
            minArgs: 2
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let name = args.name.toLowerCase();
            let desc = this._data[name];

            if (!desc) {
                ep.reply("There is no custom command with that name.");
                return true;
            }

            if ((desc.owner.envname != env.name || desc.owner.userid != userid)
                    && !await testIsModerator(env.name, userid, channelid)) {
                ep.reply("You are not the owner of this command.");
                return true;
            }

            let descriptionlist = args.description.join(" ").split(/[\|\n]/);

            desc.description = descriptionlist[0];
            desc.details = descriptionlist.slice(1);
            this._data.save();

            ep.reply("Description for the command '" + name + "' was successfully replaced.");

            this.registerCommandFromDynamicDescriptor(desc);

            return true;
        });


        this.be("Commands").registerCommand(this, 'cmd set environments', {
            description: 'Restrict which message types and environments are allowed to use a custom command.',
            details: [
                "Available message types depend on the environment, but 'public' and 'private' are usually available.",
                "Use | to separate the lists of multiple message types or multiple environments.",
            ],
            args: ["name", "types", "environments"],
            minArgs: 1
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let name = args.name.toLowerCase();
            let desc = this._data[name];

            if (!desc) {
                ep.reply("There is no custom command with that name.");
                return true;
            }

            if ((desc.owner.envname != env.name || desc.owner.userid != userid)
                    && !await testIsModerator(env.name, userid, channelid)) {
                ep.reply("You are not the owner of this command.");
                return true;
            }

            let types = args.types.split("|");
            if (types.length == 1 && types[0] == "-") types = [];

            for (let type of types) {
                if (this.param("types") && this.param("types").indexOf(type) < 0) {
                    ep.reply("Type not allowed: " + type);
                    return true;
                }
            }

            let environments = args.environments.split("|");

            for (let targetenvname of environments) {
                if (!opt.envExists(targetenvname)) {
                    ep.reply("Environment not found: " + targetenvname);
                    return true;
                }
                if (this.param("envs") && this.param("envs").indexOf(targetenvname) < 0) {
                    ep.reply("Environment not allowed: " + targetenvname);
                    return true;
                }
            }

            if (types.length) {
                desc.types = types;
            } else {
                desc.types = this.param("types") || null;
            }

            if (environments.length) {
                desc.environments = environments;
                ep.reply("Permitted environments for the command '" + name + "' were successfully set.");
            } else {
                desc.environments = this.param("envs") || null;
                ep.reply("Permitted environments for the command '" + name + "' were successfully reset.");
            }

            this._data.save();

            this.registerCommandFromDynamicDescriptor(desc);

            return true;
        });


        this.be("Commands").registerCommand(this, 'cmd set permissions', {
            description: 'Restrict usage of a custom command to users who have one permission from the provided list.',
            args: ["name", "permissions", true],
            minArgs: 1
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let name = args.name.toLowerCase();
            let desc = this._data[name];

            if (!desc) {
                ep.reply("There is no custom command with that name.");
                return true;
            }

            if ((desc.owner.envname != env.name || desc.owner.userid != userid)
                    && !await testIsModerator(env.name, userid, channelid)) {
                ep.reply("You are not the owner of this command.");
                return true;
            }

            if (args.permissions.length) {
                desc.permissions = args.permissions;
                ep.reply("Sufficient permissions for using the command '" + name + "' were successfully set.");
            } else {
                desc.permissions = null;
                ep.reply("Permissions for using the command '" + name + "' were successfully cleared.");
            }
            this._data.save();

            this.registerCommandFromDynamicDescriptor(desc);

            return true;
        });


        this.be("Commands").registerCommand(this, 'cmd reply add', {
            description: 'Adds a reply to the command. At least one reply is required for the command to work.',
            details: [
                "If you add multiple replies, for each use of the command one of them will be randomly selected.",
                "You can use the following placeholders in the reply:",
                "  {ARG} - Will be replaced by the contents of the command argument ARG.",
                "  {envname} - The name of the environment where the command was used.",
                "  {userid} - The ID of the user who used the command in the environment.",
                "  {displayname} - The display name of the user of the command in the environment.",
                "  {channelid} - The ID of the channel where the command was used in the environment.",
                "  {channelname} - The name of the channel where the command was used.",
                "You can use the syntax {%[COMMAND:]CRITERIA,...[:(^|_)]%} to include inline usage statistics of COMMAND in your command.",
                "  COMMAND must be a custom command you own, or you must be an administrator. Ommit to use the current command.",
                "  The optional ^ or _ at the end return the highest or lowest result count instead of the amount of results.",
                "  The other placeholders resolve before this one and can be used in the list of CRITERIA.",
                "  To see the syntax for CRITERIA, check the help for cmd stats."
            ],
            args: ["name", "reply", true],
            minArgs: 2
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let name = args.name.toLowerCase();
            let desc = this._data[name];

            if (!desc) {
                ep.reply("There is no custom command with that name.");
                return true;
            }

            if ((desc.owner.envname != env.name || desc.owner.userid != userid)
                    && !await testIsModerator(env.name, userid, channelid)) {
                ep.reply("You are not the owner of this command.");
                return true;
            }

            let reply = args.reply.join(" ");
            let testreply = reply.toLowerCase();
            
            if (desc.reply.filter(item => item.toLowerCase() == testreply).length > 0) {
                ep.reply("This reply already exists.");
                return true;
            }

            desc.reply.push(reply);
            this._data.save();

            ep.reply("A reply for the command '" + name + "' was successfully added.");

            return true;
        });


        this.be("Commands").registerCommand(this, 'cmd reply del', {
            description: 'Removes a reply from the command.',
            args: ["name", "reply", true],
            minArgs: 2
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let name = args.name.toLowerCase();
            let desc = this._data[name];

            if (!desc) {
                ep.reply("There is no custom command with that name.");
                return true;
            }

            if ((desc.owner.envname != env.name || desc.owner.userid != userid)
                    && !await testIsModerator(env.name, userid, channelid)) {
                ep.reply("You are not the owner of this command.");
                return true;
            }

            let reply = args.reply.join(" ");
            let testreply = reply.toLowerCase();

            let pos = desc.reply.findIndex(item => item.toLowerCase() == testreply);
            if (pos < 0) {
                ep.reply("This reply does not exist.");
                return true;
            }

            desc.reply.splice(pos, 1);

            this._data.save();

            ep.reply("A reply for the command '" + name + "' was successfully removed.");

            return true;
        });


        this.be("Commands").registerCommand(this, 'cmd reply list', {
            description: 'Lists a command\'s existing replies.',
            args: ["name"],
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let name = args.name.toLowerCase();
            let desc = this._data[name];

            if (!desc) {
                ep.reply("There is no custom command with that name.");
                return true;
            }

            if ((desc.owner.envname != env.name || desc.owner.userid != userid)
                    && !await testIsModerator(env.name, userid, channelid)) {
                ep.reply("You are not the owner of this command.");
                return true;
            }

            if (!desc.reply.length) {
                ep.reply("*There are no replies.*");
                return true;
            }

            if (desc.reply.length == 1) {
                ep.reply("*There is 1 reply.*");
            } else {
                ep.reply("*There are " + desc.reply.length + " replies.*");
            }

            for (let reply of desc.reply) {
                ep.reply("`" + reply + "`");
            }

            return true;
        });


        this.be("Commands").registerCommand(this, 'cmd stats', {
            description: 'Shows usage statistics for a custom command.',
            args: ["name", "criteria"],
            details: [
                "The CRITERIA are a comma-separated list. Syntax for each: (envname|userid|channelid|ARG)[=VALUE]",
                "If a value is provided, the results are filtered by that value, otherwise they are aggregated."
            ],
            minArgs: 1
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let name = args.name.toLowerCase();
            let desc = this._data[name];

            if (!desc) {
                ep.reply("There is no custom command with that name.");
                return true;
            }

            if ((desc.owner.envname != env.name || desc.owner.userid != userid)
                    && !await testIsModerator(env.name, userid, channelid)) {
                ep.reply("You are not the owner of this command.");
                return true;
            }

            let stats = this.calculateStatsByCriteria(args.criteria, desc.calls);
            let displaylist = [];
            for (let key in stats) {
                displaylist.push([this.userFriendlyLabelFromMap(stats[key].fields), stats[key].count]);
            }

            if (!displaylist.length) {
                ep.reply("No results found.");
                return true;
            }

            displaylist.sort((a, b) => a.count - b.count);
            for (let item of displaylist) {
                ep.reply(item[0] + ": **" + item[1] + "**");
            }

            return true;
        });


        this.be("Commands").registerCommand(this, 'cmd reset', {
            description: 'Reset usage statistics and data for a custom command.',
            args: ["name"]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let name = args.name.toLowerCase();
            let desc = this._data[name];

            if (!desc) {
                ep.reply("There is no custom command with that name.");
                return true;
            }

            if ((desc.owner.envname != env.name || desc.owner.userid != userid)
                    && !await testIsModerator(env.name, userid, channelid)) {
                ep.reply("You are not the owner of this command.");
                return true;
            }

            desc.calls = [];
            this._data.save();

            ep.reply("Usage stats for command '" + name + "' successfully reset.");

            return true;
        });


        this.be("Commands").registerCommand(this, 'cmd destroy', {
            description: 'Destroy a custom command.',
            args: ["name"]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let name = args.name.toLowerCase();
            let desc = this._data[name];

            if (!desc) {
                ep.reply("There is no custom command with that name.");
                return true;
            }

            if ((desc.owner.envname != env.name || desc.owner.userid != userid)
                    && !await testIsModerator(env.name, userid, channelid)) {
                ep.reply("You are not the owner of this command.");
                return true;
            }

            let commanddesc = await this.be("Commands").getCommand(name);
            if (commanddesc && commanddesc.behavior == this.type) {
                await this.be("Commands").unregisterCommand(name);
            }

            delete this._data[name];
            this._data.save();

            ep.reply("The command '" + name + "' was destroyed.");

            return true;
        });


        return true;
    }


    // # Module code below this line #


    //Unregister the command from ModCommands (if necessary) and register it again (if possible)

    async registerCommandFromDynamicDescriptor(desc) {
        
        let commanddesc = await this.be("Commands").getCommand(desc.name);
        if (commanddesc) {
            if (commanddesc.behavior == this.type) {
                await this.be("Commands").unregisterCommand(desc.name);
            } else {
                return false;
            }
        }

        let rdetails = (desc.details || []).slice();
        let ownername = await this.env(desc.owner.envname)?.idToDisplayName(desc.owner.userid);
        if (ownername) {
            rdetails.push("*Custom command owner: " + ownername + "*");
        } else {
            rdetails.push("*This is a custom command.");
        }

        this.be("Commands").registerCommand(this, desc.name, {
            args: desc.args,
            minArgs: desc.minArgs,
            description: desc.description,
            details: rdetails,
            environments: desc.environments,
            types: desc.types,
            permissions: desc.permissions
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            if (desc.reply.length == 0) return true;

            desc.calls.push({envname: env.name, userid: userid, channelid: channelid, args: Object.assign({}, args)});

            let reply = desc.reply[Math.floor(random.fraction() * desc.reply.length)];

            reply = reply.replace(/\{envname\}/g, env.name)
                        .replace(/\{userid\}/g, userid)
                        .replace(/\{displayname\}/g, env.idToDisplayName(userid))
                        .replace(/\{channelid\}/g, channelid)
                        .replace(/\{channelname\}/g, env.channelIdToDisplayName(channelid));

            for (let arg in args) {
                let re = new RegExp("\\{" + arg + "\\}", "g");
                reply = reply.replace(re, args[arg] || "");
            }

            let matches;
            while ((matches = reply.match(/\{%(([a-z][a-z0-9_-]*):)?([^:]*)(:([_^]))?%\}/))) {

                let srccmddesc = this._data[matches[2]];
                if (!srccmddesc) {
                    srccmddesc = desc;
                } else if ((srccmddesc.owner.envname != desc.owner.envname || srccmddesc.owner.userid != desc.owner.userid)
                        && !await this._testIsModerator(desc.owner.envname, desc.owner.userid)) {
                    reply = reply.replace(matches[0], "");
                    continue;
                }

                let stats = this.calculateStatsByCriteria(matches[3], srccmddesc.calls);
                
                let replacement = Object.keys(stats);
                if (matches[5] == "_") replacement = (replacement.length > 0 ? stats[replacement[replacement.length - 1]].count : 0);
                else if (matches[5] == "^") replacement = (replacement.length > 0 ? stats[replacement[0]].count : 0);
                else replacement = replacement.length;

                reply = reply.replace(matches[0], replacement);
            }

            ep.reply(reply);

            return true;
        });

        return true;
    }


    //Obtain command stats

    keyFromFields(fields, call) {
        let key = [];
        for (let field of fields) {
            if (call[field] !== undefined) key.push(call[field].toLowerCase().replace(/§/g, ""));
            else if (call.args[field] !== undefined) key.push(call.args[field].toLowerCase().replace(/§/g, ""));
        }
        return key.join("§");
    }

    mapFromFields(fields, call) {
        let map = {};
        for (let field of fields) {
            if (call[field] !== undefined) map[field] = call[field];
            else if (call.args[field] !== undefined) map[field] = call.args[field];
        }
        return map;
    }

    userFriendlyLabelFromMap(map) {
        let label = [];
        for (let field in map) {
            label.push(field + "=" + map[field]);
        }
        return label.join(", ");
    }

    calculateStatsByCriteria(criteria, calls) {

        criteria = criteria ? criteria.split(",") : [];

        //First apply filters

        let filteredcalls = [];
        let hasfilters = false;

        for (let criterium of criteria) {
            let parts = criterium.match(/^([^=]+)=(.+)$/);
            if (!parts || parts.length <= 2) continue;
            hasfilters = true;
            for (let call of calls) {
                if (call[parts[1]] !== undefined && call[parts[1]].toLowerCase() == parts[2].toLowerCase()
                        || call.args[parts[1]] !== undefined && call.args[parts[1]].toLowerCase() == parts[2].toLowerCase()) {
                    filteredcalls.push(call);
                }
            }
        }
        
        if (!hasfilters) {
            filteredcalls = calls;
        }

        //Second apply aggregations

        let aggs = [];
        for (let criterium of criteria) {
            if (!criterium.match(/^([^=]+)$/)) continue;
            aggs.push(criterium);
        }

        let aggrgeds = {};
        for (let call of filteredcalls) {
            let aggrged = this.keyFromFields(aggs, call);
            if (!aggrgeds[aggrged]) {
                aggrgeds[aggrged] = {
                    fields: this.mapFromFields(aggs, call),
                    count: 1
                };
            } else {
                aggrgeds[aggrged].count += 1;
            }
        }

        return aggrgeds;
    }


}
