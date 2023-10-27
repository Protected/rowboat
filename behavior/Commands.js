import Behavior from '../src/Behavior.js';

const DISCORD_ENVIRONMENT = "Discord";  //Type match for specific behavior
const OK_EMOJI = '✅';

export default class Commands extends Behavior {

    get description() { return "Framework for providing responses to text triggers in a standardized format"; }

    get params() { return [
        {n: 'defaultprefix', d: "Default prefix for text commands"},
        {n: 'allowedenvs', d: "List of environments to activate this behavior on (null means all)"},
        {n: 'prefixes', d: "Map of per-environment command prefixes {name: prefix, ...}"},
        {n: 'permissions', d: "Map of permission overrides {command: [permission, ...], ...}"},
        {n: 'aliases', d: "Map of command aliases {command: [alias, ...], ...}"},
        {n: 'logTemplateCommand', d: "Template for the EventLogger behavior, if present (the channel will be 'command')"}
    ]; }

    get defaults() { return {
        
        defaultprefix: "!",
        allowedenvs: null,  //All of them
        prefixes: {},

        //{command: [permission, ...], ...} Also supports: true (always allow) and false (disable command)
        permissions: {},

        //{command: [alias, ...], ...} Note: Permission overrides for commands do not propagate to their aliases.
        //You can rename a command by disabling it using a permission override and then providing an alias for it.
        //You can also independently provide permission overrides for aliases.
        aliases: {},

        //The following placeholders can be used: %(MOMENT_FORMAT)% %env% %userid% %user% %channelid% %channel% %message%
        logTemplateCommand: "%(HH:mm:ss)% {%env%} [%channel%] !! %user% %message%"

    }; }
    
    get requiredBehaviors() { return {
        Users: "Users"
    }; }

    get optionalBehaviors() { return {
        EventLogger: "EventLogger"
    }; }

    get isRootAccess() { return true; }

    constructor(name) {
        super('Commands', name);
    
        this._config = null;
        this._root = null;

        this._commands = [];
        this._index = {};
        this._rootDetails = {};
        
    }


    initialize(opt) {
        if (!super.initialize(opt)) return false;

        this._config = opt.config;
        this._root = opt.root;


        //Register callbacks
        
        if (!this.param('allowedenvs')) {
            this.env().on('message', this.onCommandMessage, this);
        } else {
            for (let name of allowedenvs) {
                opt.envProxy(name).on('message', this.onCommandMessage, this);
            }
        }

        const permAdmin = this.be("Users").defaultPermAdmin;
        
        this.registerCommand(this, 'help', {
            description: "Obtain a list of commands or information about a specific command.",
            args: ["command", true],
            minArgs: 0,
            unobtrusive: true
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (args.command.length > 0) {
                let command = args.command.join(" ");
                let descriptor = this._index[command.toLowerCase()];
                let subcommands = this.findSubcommands(command);
                
                if (!descriptor && !subcommands.length) {
                    ep.reply('No such command!');
                    return true;
                }
                
                if (!descriptor) {
                    ep.reply('  **' + command + '** *SUBCOMMAND* [...]');
                    
                    let parts = command.toLowerCase().match(/^([^ ]+)/);
                    if (parts && this._rootDetails[parts[1]]) {
                        let rootdetails = this._rootDetails[parts[1]];
                        if (rootdetails.description) ep.reply('    ' + rootdetails.description);
                        if (rootdetails.details && rootdetails.details.length) {
                            ep.reply('');
                            for (let line of rootdetails.details) {
                                ep.reply('    ' + line);
                            }
                        }
                    }
                    
                } else {
                    ep.reply('  ' + this.buildCommandSyntax(descriptor.command));
                    ep.reply('    ' + descriptor.description);
                    
                    if (descriptor.details && descriptor.details.length) {
                        ep.reply('');
                        for (let line of descriptor.details) {
                            ep.reply('    ' + line);
                        }
                    }
                    
                    if (descriptor.environments || descriptor.types || descriptor.permissions) {
                        ep.reply('');  //Blank line
                    }
                    
                    if (descriptor.environments) {
                        ep.reply('    Environment(s): *' + descriptor.environments.join('*, *') + '*');
                    }
                    
                    if (descriptor.types) {
                        ep.reply('    Message type(s): *' + descriptor.types.join('*, *') + '*');
                    }
                    
                    if (descriptor.permissions) {
                        let permstring = '';
                        if (descriptor.permissions.length == 0) {
                            permstring = 'LOCKED';
                        } else {
                            if (descriptor.permissions.length > 1) {
                                if (descriptor.requireAllPermissions) permstring = 'All of: ';
                                else permstring = 'One of: ';
                            }
                            permstring = permstring + '*' + descriptor.permissions.join('*, *') + '*';
                        }
                        ep.reply('    Permissions required: ' + permstring);
                    }
                    
                }
                
                if (subcommands.length) {
                    ep.reply('');  //Blank line
                    ep.reply('    __Subcommands:__');
                    for (let subcommand of subcommands) {
                        
                        if (subcommand.environments && subcommand.environments.indexOf(env.type) < 0) {
                            continue;
                        }
                        
                        if (subcommand.types && subcommand.types.indexOf(type) < 0) {
                            continue;
                        }
                        
                        if (subcommand.permissions) {
                            if (!await this.be('Users').testPermissions(env.name, userid, channelid, subcommand.permissions, subcommand.requireAllPermissions)) {
                                continue;
                            }
                        }
                    
                        ep.reply('  ' + this.buildSubcommandLine(subcommand, args.command.length));
                    }
                }
            
            } else {
            
                ep.priv('Available commands (use help COMMAND for more information):');
                
                let groups = {};  //Command has subcommands, display aggregate help line if it's virtual
                let perfectmatch = {};  //Command is not virtual, so never display aggregate help line

                let commands = this._commands.slice();
                commands.sort((a, b) => a.command.localeCompare(b.command));
                
                for (let descriptor of commands) {
                
                    if (descriptor.environments && descriptor.environments.indexOf(env.type) < 0) {
                        continue;
                    }
                    
                    if (descriptor.types && descriptor.types.indexOf(type) < 0) {
                        continue;
                    }
                    
                    if (descriptor.permissions) {
                        if (!await this.be('Users').testPermissions(env.name, userid, channelid, descriptor.permissions, descriptor.requireAllPermissions)) {
                            continue;
                        }
                    }
                    
                    if (descriptor.command.toLowerCase() != descriptor.commandroot) {
                        if (perfectmatch[descriptor.commandroot]) continue;
                        if (!groups[descriptor.commandroot]) {
                            groups[descriptor.commandroot] = 1;
                        } else {
                            groups[descriptor.commandroot] += 1;
                        }
                        continue;
                    } else {
                        perfectmatch[descriptor.commandroot] = true;
                        if (groups[descriptor.commandroot]) delete groups[descriptor.commandroot];
                    }
                    
                    ep.priv('    **' + descriptor.command + '** - ' + descriptor.description);
                }
                
                for (let descriptor of commands) {
                    if (descriptor.command.toLowerCase() == descriptor.commandroot) continue;
                    if (!groups[descriptor.commandroot]) continue;
                    let description = 'Contains ' + groups[descriptor.commandroot] + ' subcommand' + (groups[descriptor.commandroot] == 1 ? '' : 's') + '.';
                    if (this._rootDetails[descriptor.commandroot] && this._rootDetails[descriptor.commandroot].description) {
                        description = this._rootDetails[descriptor.commandroot].description;
                    }
                    ep.priv('    **' + descriptor.commandroot + '** - ' + description);
                    delete groups[descriptor.commandroot];
                }
            }
        
            return true;
        });


        this.registerCommand(this, 'reload', {
            description: "Reload this application. All environments and behaviors will be reloaded.",
            types: ["private"],
            permissions: [permAdmin]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
        
            ep.reply('Reloading...');
            this.log('Reloading Rowboat by request from ' + handle + ' in ' + env.name);
            
            await this._root.stopEnvironments(); //Note: Invalidates reply callback

            if (!this._config.loadMasterConfig()) {
                this.log('error','Failed to load master config.');
                process.exit(2);
            }
            
            this._root.resetContext();
            
            if (!await this._root.loadEnvironments()) {
                this.log('error','Failed to load environments.');
                process.exit(3);
            }
            
            if (!await this._root.loadBehaviors()) {
                this.log('error','Failed to load behaviors.');
                process.exit(4);
            }
            
            await this._root.runEnvironments();
        
            this.log('Reload successful.');
        
            return true;
        });
        
        
        this.registerCommand(this, 'environments', {
            description: "Lists the configured enviroments.",
            permissions: [permAdmin]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let allenvs = this._root.getAllEnvironments();
            if (!allenvs || !Object.keys(allenvs).length) {
                ep.reply ("No environments found.");
                return true;
            }
            
            for (let name in allenvs) {
                let thatenv = allenvs[name];
                ep.reply ("  {**" + name + "**} - " + thatenv.type);
            }
        
            return true;
        });
        
        
        this.registerCommand(this, 'behaviors', {
            description: "Lists the configured behaviors.",
            permissions: [permAdmin]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let allbes = this._root.getAllBehaviors();
            if (!allbes || !Object.keys(allbes).length) {
                ep.reply ("No behaviors found.");
                return true;
            }
            
            let display = {};
            
            for (let name in allbes) {
                let thatbe = allbes[name];
                if (!display[thatbe.type]) {
                    display[thatbe.type] = [];
                }
                display[thatbe.type].push(thatbe);
            }
            
            for (let type in display) {
                if (!display[type][0].isMultiInstanceable) {
                    ep.reply ("  |**" + type + "**|");
                } else {
                    let line = [];
                    for (let be of display[type]) {
                        line.push("|" + be.name + "|");
                    }
                    ep.reply ("  **" + type + "**: " + line.join(", "));
                }
            }
        
            return true;
        });
        
        
        return true;
    }


    // # Module code below this line #


    //Register a command that can be invoked by users.
    registerCommand(behavior, command, options, callback) {
        if (arguments.length == 3) {
            callback = options;
            options = {};
        }
        if (!options) options = {};
        if (!command || !callback) return false;
        
        let commandid = command.toLowerCase();
        let commandroot = commandid;
        let commandtail = null;
        let parts = commandid.match(/^([^ ]+) (.+)/);
        if (parts) {
            commandroot = parts[1];
            commandtail = parts[2];
        }
        
        if (commandid.split(" ").find(item => item == "command")) {
            this.log('error', 'Unable to register the command ID "' + commandid + '" because the token "command" is reserved and cannot be used here.');
            return false;
        }

        let aliases = this.param('aliases')[commandid];
        if (Array.isArray(aliases)) {
            for (let alias of aliases) {
                this.log('-> Registering alias for the command ID "' + commandid +'": "' + alias + '"');
                this.registerCommand(behavior, alias, options, callback);
            }
        }
        
        let descriptor = {
            behavior: behavior.type,
            command: command,
            commandroot: commandroot,
            commandtail: commandtail,
            callback: {},                       //callback(env, type, userid, channelid, command, args, handle, ep)
                                                //  -- userid is the environment-side id; args is a list; handle is from Users; ep.reply/pub/priv are msg functions for context, public and private reply respectively.
            args: [],                           //List of argument names. If the last element of the list is the boolean 'true', all additional arguments will be listed in the previous argument.
            minArgs: null,                      //Minimum amount of arguments that must be passed for the callback to be invoked, or 'null' for all arguments.
            description: "",                    //Short description for the new command displayed by the list of commands in "help".
            details: [],                        //List of additional instructions displayed by "help COMMAND" (each item is one line).
            environments: null,                 //List of environment types the command can be invoked from, or null for all loaded environments.
            types: null,                        //List of message types the command can be invoked from, or null for all message types (onMessage environment callback only).
            permissions: null,                  //List of individual sufficient Users behavior permissions required for invoking this command, or null for universal use (only null allows users without accounts to invoke the command).
            requireAllPermissions: false,       //If this boolean is true, the above list becomes a list of necessary permissions (all listed permissions will be simultaneously required).
            unobtrusive: false                  //If this boolean is true, priv will send a notice rather than a message.
        }
        
        descriptor.callback[behavior.name] = callback;
        
        if (options) {
            if (options.args) descriptor.args = options.args;
            if (options.minArgs !== undefined) descriptor.minArgs = options.minArgs;
            if (options.description) descriptor.description = options.description;
            if (options.details) descriptor.details = options.details;
            if (options.environments) descriptor.environments = options.environments;
            if (options.types) descriptor.types = options.types;
            if (options.permissions) descriptor.permissions = options.permissions;
            if (options.requireAllPermissions) descriptor.requireAllPermissions = options.requireAllPermissions;
            if (options.unobtrusive) descriptor.unobtrusive = options.unobtrusive;
        }
        
        let po = this.param('permissions')[commandid];
        if (po === true) {
            this.log('Permission override for the command ID "' + commandid + '": Always allow');
            descriptor.permissions = null;
        }
        if (po === false) {
            this.log('Permission override for the command ID "' + commandid + '": Disable command');
            return true;
        }
        if (Array.isArray(po)) {
            this.log('Permission override for the command ID "' + commandid + '": ' + po.join(", "));
            descriptor.permissions = po;
            descriptor.requireAllPermissions = false;
        }
        
        let deets = this._rootDetails[commandroot];
        if (deets) {
            if (deets.behavior != behavior.type && !deets.extensions[behavior.type]) {
                this.log('warn', 'Unable to register the command ID "' + commandid + '" because the root "' + commandroot + '" was previously claimed by |' + deets.type + '|.');
                return false;
            }
        } else {
            let existsroot = this.findFirstCommandByRoot(commandroot);
            if (existsroot && existsroot.behavior != behavior.type) {
                this.log('warn', 'Unable to register the command ID "' + commandid + '" because the root "' + commandroot + '" was previously registered by |' + existsroot.behavior + '|.');
                return false;
            }
        }
        
        let exists = this.getCommand(commandid);
        if (exists) {
            exists.callback[behavior.name] = callback;
        } else {
            this._commands.push(descriptor);
            this._index[commandid] = descriptor;
        }
        
        this.log('Registered command: ' + this.stripNormalizedFormatting(this.buildCommandSyntax(command))
                + (descriptor.permissions ? ' (permissions: ' + (descriptor.requireAllPermissions ? 'all of ' : 'any of ') + descriptor.permissions.join(', ') + ')' : ''));
        
        return true;
    }
    
    unregisterCommand(command) {
        let descriptor = this.getCommand(command);
        if (!descriptor) return false;
    
        let commandid = command.toLowerCase();
        
        this._commands = this._commands.filter((item) => (item.command.toLowerCase() != commandid));
        if (this._index[commandid]) delete this._index[commandid];
        
        this.log('Unregistered command: ' + command);
        
        return true;
    }
    
    
    //Register metadata for a group of commands shared by multiple subcommands.
    registerRootDetails(behavior, commandroot, options) {
        commandroot = commandroot.toLowerCase();

        let aliases = this.param('aliases')[commandroot];
        if (Array.isArray(aliases)) {
            for (let alias of aliases) {
                this.log('-> Registering alias for the root "' + commandroot +'": "' + alias + '"');
                this.registerRootDetails(behavior, alias, options);
            }
        }

        let rootdescriptor = {
            behavior: behavior.type,
            commandroot: commandroot,
            description: "",
            details: [],
            extensions: {}
        };
        
        if (options) {
            if (options.description) rootdescriptor.description = options.description;
            if (options.details) rootdescriptor.details = options.details;
        }
        
        this._rootDetails[commandroot] = rootdescriptor;
        
        this.log('Registered details for root: ' + commandroot);
        return true;
    }
    
    unregisterRootDetails(commandroot) {
        commandroot = commandroot.toLowerCase();
        if (!this._rootDetails[commandroot]) return false;
        delete this._rootDetails[commandroot];
        this.log('Unregistered details for root: ' + commandroot);
        return true;
    }
    

    getCommand(command) {
        if (!command) return null;
        return this._index[command.toLowerCase()];
    }
    
    findFirstCommandByRoot(commandroot) {
        if (!commandroot) return null;
        return this._commands.find(item => item.commandroot == commandroot);
    }
    
    findSubcommands(commandpath) {
        if (!commandpath) return null;
        commandpath = commandpath.toLowerCase();
        let cplength = commandpath.split(" ").length;
        return this._commands.filter(
            (item) => item.command.toLowerCase().split(" ").slice(0, cplength).join(" ") == commandpath && item.command.toLowerCase() != commandpath
        );
    }
    
    
    //Register a sub-behavior with a group of commands so it can add subcommands to that group (registerRootDetails must have been called by a requiredBehavior).
    registerRootExtension(behavior, rootBehaviorType, commandroot) {
        commandroot = commandroot.toLowerCase();
                
        if (!this._rootDetails[commandroot]) {
            this.log('warn', 'Details not found for the root "' + commandroot + '" when registering an extension behavior.');
            return false;
        }
        
        if (this._rootDetails[commandroot].behavior != rootBehaviorType) {
            this.log('warn', 'Could not register an extension behavior on root "' + commandroot + '" because it was not claimed by |' + rootBehaviorType + '| but by |' + this._rootDetails[commandroot].behavior + '|.');
            return false;
        }
        
        this._rootDetails[commandroot].extensions[behavior.type] = true;
        
        return true;
    }
    


    //Event handler

    async onCommandMessage(env, type, message, authorid, channelid, rawobject) {

        let prefix = this.param('defaultprefix');
        let prefixes = this.param('prefixes');
        if (prefixes[env.name]) prefix = prefixes[env.name];
        if (!message.startsWith(prefix)) return;
        
        
        //Identify command being used
        
        let command = null;
        let cmdwords = 0;
        
        let cmdline = message.substr(prefix.length);
        for (let commandid in this._index) {
            if (cmdline.toLowerCase().indexOf(commandid) !== 0) continue;
            if (cmdline.length !== commandid.length && cmdline.substr(commandid.length, 1) != ' ') continue;
            let thesewords = commandid.split(' ').length;
            if (thesewords > cmdwords) {
                command = commandid;
                cmdwords = thesewords;
            }
        }

        if (!command) {
            //Not a known comand; Try to find subcommands
            let subcommands = this.findSubcommands(cmdline);
            if (!subcommands) return;
            for (let subcommand of subcommands) {
            
                if (subcommand.environments && subcommand.environments.indexOf(env.type) < 0) {
                    continue;
                }
                
                if (subcommand.types && subcommand.types.indexOf(type) < 0) {
                    continue;
                }
                
                if (subcommand.permissions) {
                    if (!await this.be('Users').testPermissions(env.name, authorid, channelid, subcommand.permissions, subcommand.requireAllPermissions)) {
                        continue;
                    }
                }
            
                env.msg(channelid, env.applyFormatting(this.buildSubcommandLine(subcommand, 0)));
            }
            
            return;
        }

        let args = cmdline.trim().split(/ +/).slice(cmdwords);        
        let descriptor = this._index[command];
        
        //Validate context against command descriptor
        
        if (descriptor.environments && descriptor.environments.indexOf(env.type) < 0) {
            return true;
        }
        
        if (descriptor.types && descriptor.types.indexOf(type) < 0) {
            return true;
        }

        let handles = await this.be('Users').getHandlesById(env.name, authorid, true);
        let handle = (handles.length ? handles[0] : null);

        if (descriptor.permissions) {
            if (!await this.be('Users').testPermissions(env.name, authorid, channelid, descriptor.permissions, descriptor.requireAllPermissions, handle)) {
                this.eventLog(env, authorid, channelid, 'FAILED ' + descriptor.command + ': Failed permission check.');
                return true;
            }
        }
        
        let targetmod = null;
        if (args[0] && args[0].match(/^\|.+\|$/)) {
            targetmod = args[0].substr(1, args[0].length - 2);
            args.splice(0, 1);
        }

        let knownmods = Object.keys(descriptor.callback);
        if (!targetmod && knownmods.length == 1) {
            targetmod = knownmods[0];
        }
        
        if (!targetmod || !descriptor.callback[targetmod]) {
            let baseerror = (targetmod ? 'No callback for target behavior |' + targetmod + '|' : 'Target behavior not found');
            if (descriptor.unobtrusive) {
                env.notice(authorid, env.applyFormatting(baseerror + '; Please choose one of: ' + knownmods.join(', ')));
            } else {
                env.msg(channelid, env.applyFormatting(baseerror + '; Please choose one of: ' + knownmods.join(', ')));
            }
            this.eventLog(env, authorid, channelid, 'FAILED ' + descriptor.command + (args.length ? ' ("' + args.join('", "') + '")' : '') + ': Unable to resolve target behavior.');
            return true;
        }

        
        for (let i = 0; i < args.length - 1; i++) {
            while (i < args.length - 1 && args[i].match(/^".*[^"]$/)) {
                args[i] = args[i] + ' ' + args[i+1];
                args.splice(i+1, 1);
            }
        }

        for (let i = 0; i < args.length; i++) {
            let m = args[i].match(/^"(.*)"$/);
            if (m) args[i] = m[1];
        }
        
        args = args.filter((arg) => !!arg);

        
        if (typeof descriptor.minArgs != "number") {
            descriptor.minArgs = descriptor.args.length;
            if (descriptor.args[descriptor.args.length - 1] === true) {
                descriptor.minArgs -= 1;
            }
        }

        if (args.length < descriptor.minArgs) {
            if (descriptor.unobtrusive) {
                env.notice(authorid, env.applyFormatting("Syntax: " + prefix + this.buildCommandSyntax(command)));
            } else {
                env.msg(channelid, env.applyFormatting("Syntax: " + prefix + this.buildCommandSyntax(command)));
            }
            this.eventLog(env, authorid, channelid, 'FAILED ' + descriptor.command + (args.length ? ' ("' + args.join('", "') + '")' : '') + ': Incorrect syntax.');
            return true;
        }
        
        //Prepare args map
        
        let passargs = {};
        for (let i = 0; i < descriptor.args.length; i++) {
            let argname = descriptor.args[i];
            if (i == descriptor.args.length - 2 && descriptor.args[descriptor.args.length - 1] === true) {
                passargs[argname] = args.slice(i);
                break;
            } else {
                passargs[argname] = args[i];
            }
        }
        
        //Invoke command callback
        //callback(env, type, userid, channelid, command, args, handle, ep)
        
        try {
            if (!descriptor.callback[targetmod](env, type, authorid, channelid, command, passargs, handle, {
                    reply: function(msg) {
                        let options = {};
                        if (env.type == DISCORD_ENVIRONMENT) {
                            options.reply = {
                                messageReference: rawobject.id,
                                failIfNotExists: false
                            }
                        }
                        env.msg(channelid, (typeof msg == "object" ? msg : env.applyFormatting(msg)), options);
                    },
                    pub: function(msg) {
                        env.msg((channelid == authorid ? null : channelid), (typeof msg == "object" ? msg : env.applyFormatting(msg)));
                    },
                    priv: function(msg) {
                        if (descriptor.unobtrusive) {
                            env.notice(authorid, (typeof msg == "object" ? msg : env.applyFormatting(msg)));
                        } else {
                            env.msg(authorid, (typeof msg == "object" ? msg : env.applyFormatting(msg)));
                        }
                    },
                    react: function(emoji) {
                        if (env.type == DISCORD_ENVIRONMENT) {
                            env.react(rawobject, emoji);
                        }
                    },
                    ok: function() {
                        if (env.type == DISCORD_ENVIRONMENT) {
                            env.react(rawobject, OK_EMOJI);
                        } else {
                            ep.reply("Ok.");
                        }
                    },
                    rawobject: rawobject
                }
            )) {
                this.eventLog(env, authorid, channelid, 'FAILED ' + descriptor.command + (args.length ? ' ("' + args.join('", "') + '")' : '') + ': Rejected by handler of |' + targetmod + '|.');
                if (descriptor.unobtrusive) {
                    env.notice(authorid, env.applyFormatting("Syntax: " + prefix + this.buildCommandSyntax(command)));
                } else {
                    env.msg(channelid, env.applyFormatting("Syntax: " + prefix + this.buildCommandSyntax(command)));
                }
            } else {
                this.eventLog(env, authorid, channelid, descriptor.command + (args.length ? ' ("' + args.join('", "') + '")' : ''));
            }
        } catch (e) {
            this.log('error', e);
        }

        return true;
    }
    
    
    eventLog(env, userid, channelid, message) {
        if (!this.optBeExists("EventLogger")) return;
        this.be("EventLogger").templateWrite('command', this.param('logTemplateCommand'), {
            env: env.name,
            userid: userid,
            user: env.idToDisplayName(userid),
            channelid: channelid,
            channel: (channelid ? env.channelIdToDisplayName(channelid) : null),
            message: message
        });
    }


    //Helper functions for... help

    buildCommandSyntax(command) {
        if (!this._index[command]) return "";
        let descriptor = this._index[command];
        let syntax = '**' + command + '**';
        let optionals = false;
        for (let i = 0; i < descriptor.args.length; i++) {
            syntax += ' ';
            if (descriptor.minArgs !== null && i == descriptor.minArgs && descriptor.args[i] !== true) {
                syntax += '[';
                optionals = true;
            }
            if (descriptor.args[i] === true) {
                syntax += '...';
            } else {
                syntax += '*' + descriptor.args[i].toUpperCase() + '*';
            }
        }
        if (optionals) syntax += ']';
        return syntax;
    }
    
    
    buildSubcommandLine(subcommand, prefixlength) {
        let command = subcommand.command.split(" ").slice(prefixlength).join(" ");
        return '    **' + command + '** - ' + subcommand.description;
    }
    
}
