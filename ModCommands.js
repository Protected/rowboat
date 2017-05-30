/* Module: Commands -- Framework for providing responses to triggers in a standardized format. */

//If ModLogger is present, will log to channel "command" using "templateCommand". Placeholders: %(MOMENT_FORMAT)% %env% %userid% %user% %channelid% %channel% %message%

var Module = require('./Module.js');
var moment = require('moment');

const PERM_ADMIN = 'administrator';

class ModCommands extends Module {


    get optionalParams() { return [
        'defaultprefix',        //Default prefix for commands
        'allowedenvs',          //List of environments to activate this module on
        'prefixes',             //Per-environment command prefixes
        'permissions'           //Map of permissions to override hardcoded Module defaults for each command
    ]; }
    
    get isRootAccess() { return true; }
    
    get requiredModules() { return [
        'Users'
    ]; }

    constructor(name) {
        super('Commands', name);
        
        this._params['defaultprefix'] = '!';
        this._params['allowedenvs'] = null;  //All of them
        this._params['prefixes'] = {};
        
        //{command => [permission, ...], ...} Also supports: true (always allow) and false (disable command)
        this._params['permissions'] = {};
    
        this._commands = [];
        this._index = {};
        this._rootDetails = {};
        
        this._modLogger = null;
    }


    initialize(opt) {
        if (!super.initialize(opt)) return false;

        if (!this.param('allowedenvs')) {
            this._params['allowedenvs'] = Object.keys(opt.envs);
        }
        
        
        opt.moduleRequest('Logger', (logger) => {
            this._modLogger = logger;
        });

        
        //Register callbacks
        
        for (let envname of this.param('allowedenvs')) {
            this.env(envname).on('message', this.onCommandMessage, this);
        }
        
        
        this.registerCommand(this, 'help', {
            description: "Obtain a list of commands or information about a specific command.",
            args: ["command", true],
            minArgs: 0,
            unobtrusive: true
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
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
                        
                        if (subcommand.environments && subcommand.environments.indexOf(env.envName) < 0) {
                            continue;
                        }
                        
                        if (subcommand.types && subcommand.types.indexOf(type) < 0) {
                            continue;
                        }
                        
                        if (subcommand.permissions) {
                            if (!this.mod('Users').testPermissions(env.name, userid, channelid, subcommand.permissions, subcommand.requireAllPermissions)) {
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
                
                    if (descriptor.environments && descriptor.environments.indexOf(env.envName) < 0) {
                        continue;
                    }
                    
                    if (descriptor.types && descriptor.types.indexOf(type) < 0) {
                        continue;
                    }
                    
                    if (descriptor.permissions) {
                        if (!this.mod('Users').testPermissions(env.name, userid, channelid, descriptor.permissions, descriptor.requireAllPermissions)) {
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
        
        
        this.registerCommand(this, 'time', {
            description: "Retrieve the current server time."
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            ep.reply(moment().format('dddd YYYY-MM-DD HH:mm:ss'));
        
            return true;
        });
        
        
        this.registerCommand(this, 'reload', {
            description: "Reload this application. All environments and modules will be reloaded.",
            types: ["private"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            setTimeout(() => {
                ep.reply('Reloading...');
                this.log('Reloading Rowboat by request from ' + handle + ' in ' + env.name);
                
                if (!this.mod('root').loadMasterConfig()) {
                    ep.reply('Failed to load master config.');
                    process.exit(1);
                }
                
                this.mod('root').stopEnvironments(); //Note: Invalidates reply callback
                this.mod('root').resetContext();
                
                if (!this.mod('root').loadEnvironments()) {
                    this.log('error','Failed to load environments.');
                    process.exit(1);
                }
                
                if (!this.mod('root').loadModules()) {
                    this.log('error','Failed to load modules.');
                    process.exit(1);
                }
                
                this.mod('root').runEnvironments();
            
                this.log('Reload successful.');
            }, 1);
        
            return true;
        });
        
        
        this.registerCommand(this, 'environments', {
            description: "Lists the configured enviroments.",
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            var allenvs = this.mod('root').getAllEnvironments();
            if (!allenvs || !Object.keys(allenvs).length) {
                ep.reply ("No environments found.");
                return true;
            }
            
            for (let name in allenvs) {
                let thatenv = allenvs[name];
                ep.reply ("  {**" + name + "**} - " + thatenv.envName);
            }
        
            return true;
        });
        
        
        this.registerCommand(this, 'modules', {
            description: "Lists the configured modules.",
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            var allmods = this.mod('root').getAllModules();
            if (!allmods || !Object.keys(allmods).length) {
                ep.reply ("No modules found.");
                return true;
            }
            
            let display = {};
            
            for (let name in allmods) {
                let thatmod = allmods[name];
                if (!display[thatmod.modName]) {
                    display[thatmod.modName] = [];
                }
                display[thatmod.modName].push(thatmod);
            }
            
            for (let modName in display) {
                if (!display[modName][0].isMultiInstanceable) {
                    ep.reply ("  |**" + modName + "**|");
                } else {
                    let line = [];
                    for (let mod of display[modName]) {
                        line.push("|" + mod.name + "|");
                    }
                    ep.reply ("  **" + modName + "**: " + line.join(", "));
                }
            }
        
            return true;
        });
        
        
        return true;
    }


    // # Module code below this line #


    //Register a command that can be invoked by users.
    registerCommand(mod, command, options, callback) {
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
        
        if (commandid.split(" ").find((item) => item == "command")) {
            this.log('error', 'Unable to register the command ID "' + commandid + '" because the token "command" is reserved and cannot be used here.');
            return false;
        }
        
        let descriptor = {
            modName: mod.modName,
            command: command,
            commandroot: commandroot,
            commandtail: commandtail,
            callback: {},                       //callback(env, type, userid, channelid, command, args, handle, ep)
                                                //  -- userid is the environment-side id; args is a list; handle is from ModUsers; ep.reply/pub/priv are msg functions for context, public and private reply respectively.
            args: [],                           //List of argument names. If the last element of the list is the boolean 'true', all additional arguments will be listed in the previous argument.
            minArgs: null,                      //Minimum amount of arguments that must be passed for the callback to be invoked, or 'null' for all arguments.
            description: "",                    //Short description for the new command displayed by the list of commands in "help".
            details: [],                        //List of additional instructions displayed by "help COMMAND" (each item is one line).
            environments: null,                 //List of environment names the command can be invoked from, or null for all loaded environments.
            types: null,                        //List of message types the command can be invoked from, or null for all message types (onMessage environment callback only).
            permissions: null,                  //List of individual sufficient permissions required for invoking this command, or null for universal use (only null allows users without accounts to invoke the command).
            requireAllPermissions: false,       //If this boolean is true, the above list becomes a list of necessary permissions (all listed permissions will be simultaneously required).
            unobtrusive: false                  //If this boolean is true, priv will send a notice rather than a message.
        }
        
        descriptor.callback[mod.name] = callback;
        
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
            if (deets.modName != mod.modName && !deets.extensions[mod.modName]) {
                this.log('warn', 'Unable to register the command ID "' + commandid + '" because the root "' + commandroot + '" was previously claimed by |' + deets.modName + '|.');
                return false;
            }
        } else {
            let existsroot = this.findFirstCommandByRoot(commandroot);
            if (existsroot && existsroot.modName != mod.modName) {
                this.log('warn', 'Unable to register the command ID "' + commandid + '" because the root "' + commandroot + '" was previously registered by |' + existsroot.modName + '|.');
                return false;
            }
        }
        
        let exists = this.getCommand(commandid);
        if (exists) {
            exists.callback[mod.name] = callback;
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
    registerRootDetails(mod, commandroot, options) {
        commandroot = commandroot.toLowerCase();
        let rootdescriptor = {
            modName: mod.modName,
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
        return this._commands.find((item) => item.commandroot == commandroot);
    }
    
    findSubcommands(commandpath) {
        if (!commandpath) return null;
        commandpath = commandpath.toLowerCase();
        let cplength = commandpath.split(" ").length;
        return this._commands.filter(
            (item) => item.command.toLowerCase().split(" ").slice(0, cplength).join(" ") == commandpath && item.command.toLowerCase() != commandpath
        );
    }
    
    
    //Register a submodule with a group of commands so it can add subcommands to that group (registerRootDetails must have been called by a requiredModule).
    registerRootExtension(mod, rootModName, commandroot) {
        commandroot = commandroot.toLowerCase();
                
        if (!this._rootDetails[commandroot]) {
            this.log('warn', 'Details not found for the root "' + commandroot + '" when registering an extension module.');
            return false;
        }
        
        if (this._rootDetails[commandroot].modName != rootModName) {
            this.log('warn', 'Could not register an extension module on root "' + commandroot + '" because it was not claimed by |' + rootModName + '| but by |' + this._rootDetails[commandroot].modName + '|.');
            return false;
        }
        
        this._rootDetails[commandroot].extensions[mod.modName] = true;
        
        return true;
    }
    


    //Event handler

    onCommandMessage(env, type, message, authorid, channelid, rawobject) {

        var prefix = this.param('defaultprefix');
        var prefixes = this.param('prefixes');
        if (prefixes[env.name]) prefix = prefixes[env.name];
        if (!message.startsWith(prefix)) return;
        
        //Identify command being used
        
        var command = null;
        var cmdwords = 0;
        
        var cmdline = message.substr(prefix.length);
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
            for (let subcommand of subcommands) {
            
                if (subcommand.environments && subcommand.environments.indexOf(env.envName) < 0) {
                    continue;
                }
                
                if (subcommand.types && subcommand.types.indexOf(type) < 0) {
                    continue;
                }
                
                if (subcommand.permissions) {
                    if (!this.mod('Users').testPermissions(env.name, authorid, channelid, subcommand.permissions, subcommand.requireAllPermissions)) {
                        continue;
                    }
                }
            
                env.msg(channelid, env.applyFormatting(this.buildSubcommandLine(subcommand, 0)));
            }
            
            return;
        }

        var args = cmdline.trim().split(/ +/).slice(cmdwords);        
        var descriptor = this._index[command];
        
        //Validate context against command descriptor
        
        if (descriptor.environments && descriptor.environments.indexOf(env.envName) < 0) {
            return true;
        }
        
        if (descriptor.types && descriptor.types.indexOf(type) < 0) {
            return true;
        }
        
        var handles = this.mod('Users').getHandlesById(env.name, authorid, true);
        var handle = (handles.length ? handles[0] : null);
        
        if (descriptor.permissions) {
            if (!this.mod('Users').testPermissions(env.name, authorid, channelid, descriptor.permissions, descriptor.requireAllPermissions, handle)) {
                this.eventLog(env, authorid, channelid, 'FAILED ' + descriptor.command + ': Failed permission check.');
                return true;
            }
        }
        
        var targetmod = null;
        if (args[0] && args[0].match(/^\|.+\|$/)) {
            targetmod = args[0].substr(1, args[0].length - 2);
            args.splice(0, 1);
        }

        var knownmods = Object.keys(descriptor.callback);
        if (!targetmod && knownmods.length == 1) {
            targetmod = knownmods[0];
        }
        
        if (!targetmod || !descriptor.callback[targetmod]) {
            let baseerror = (targetmod ? 'No callback for target module |' + targetmod + '|' : 'Target module not found');
            if (descriptor.unobtrusive) {
                env.notice(authorid, env.applyFormatting(baseerror + '; Please choose one of: ' + knownmods.join(', ')));
            } else {
                env.msg(channelid, env.applyFormatting(baseerror + '; Please choose one of: ' + knownmods.join(', ')));
            }
            this.eventLog(env, authorid, channelid, 'FAILED ' + descriptor.command + (args.length ? ' ("' + args.join('", "') + '")' : '') + ': Unable to resolve target module.');
            return true;
        }
        
        
        for (var i = 0; i < args.length - 1; i++) {
            while (i < args.length - 1 && args[i].match(/^".*[^"]$/)) {
                args[i] = args[i] + ' ' + args[i+1];
                args.splice(i+1, 1);
            }
        }

        for (var i = 0; i < args.length; i++) {
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
        
        var passargs = {};
        for (var i = 0; i < descriptor.args.length; i++) {
            var argname = descriptor.args[i];
            if (i == descriptor.args.length - 2 && descriptor.args[descriptor.args.length - 1] === true) {
                passargs[argname] = args.slice(i);
                break;
            } else {
                passargs[argname] = args[i];
            }
        }
        
        //Invoke command callback
        //callback(env, type, userid, channelid, command, args, handle, ep)
        
        if (!descriptor.callback[targetmod](env, type, authorid, channelid, command, passargs, handle, {
                reply: function(msg) {
                    env.msg(channelid, env.applyFormatting(msg));
                },
                pub: function(msg) {
                    env.msg((channelid == authorid ? null : channelid), env.applyFormatting(msg));
                },
                priv: function(msg) {
                    if (descriptor.unobtrusive) {
                        env.notice(authorid, env.applyFormatting(msg));
                    } else {
                        env.msg(authorid, env.applyFormatting(msg));
                    }
                }
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

        return true;
    }
    
    
    eventLog(env, userid, channelid, message) {
        if (this._modLogger) {
            this._modLogger.templateNameWrite('command', 'command', {
                env: env.name,
                userid: userid,
                user: env.idToDisplayName(userid),
                channelid: channelid,
                channel: (channelid ? env.channelIdToDisplayName(channelid) : null),
                message: message
            });
        }
    }


    //Helper functions for... help

    buildCommandSyntax(command) {
        if (!this._index[command]) return "";
        var descriptor = this._index[command];
        var syntax = '**' + command + '**';
        var optionals = false;
        for (var i = 0; i < descriptor.args.length; i++) {
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


module.exports = ModCommands;
