/* Module: Commands -- Framework for providing responses to triggers in a standardized format. */

//If ModLogger is present, will log to channel "command" using "templateCommand". Placeholders: %(MOMENT_FORMAT)% %env% %userid% %user% %channelid% %channel% %message%

var Module = require('./Module.js');
var moment = require('moment');

var PERM_ADMIN = 'administrator';

class ModCommands extends Module {


    get optionalParams() { return [
        'defaultprefix',        //Default prefix for commands
        'allowedenvs',          //List of environments to activate this module on
        'prefixes'              //Per-environment, per-source command prefixes
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
    
        this._commands = [];
        this._index = {};
        
        this._modLogger = null;
    }


    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;

        if (!this.param('allowedenvs')) {
            this._params['allowedenvs'] = Object.keys(envs);
        }
        
        
        moduleRequest('Logger', (logger) => {
            this._modLogger = logger;
        });

        
        //Register callbacks
        
        for (let envname of this.param('allowedenvs')) {
            this.env(envname).on('message', this.onCommandMessage, this);
        }
        
        
        this.registerCommand(this, 'help', {
            description: "Obtain a list of commands or information about a specific command.",
            args: ["command"],
            minArgs: 0,
            unobtrusive: true
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (args.command) {
                var descriptor = this._index[args.command.toLowerCase()];
                if (!descriptor) {
                    ep.reply('No such command!');
                    return true;
                }
            
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
                    var permstring = '';
                    if (descriptor.permissions.length == 0) {
                        permstring = 'LOCKED';
                    } else {
                        if (descriptor.permissions.length > 1) {
                            if (descriptor.requireAllPermissions) permstring = 'All of: ';
                            else permstring = 'One of: *';
                        }
                        permstring = permstring + descriptor.permissions.join('*, *') + '*';
                    }
                    ep.reply('    Permissions required: ' + permstring);
                }
            
            } else {
            
                ep.priv('Available commands (use help COMMAND for more information):');
                
                for (let descriptor of this._commands) {

                    if (descriptor.environments && descriptor.environments.indexOf(env.envName) < 0) {
                        continue;
                    }
                    
                    if (descriptor.types && descriptor.types.indexOf(type) < 0) {
                        continue;
                    }
                    
                    if (descriptor.permissions) {
                        if (!this.mod('Users').testPermissions(env.name, userid, descriptor.permissions, descriptor.requireAllPermissions)) {
                            continue;
                        }
                    }
                    
                    ep.priv('    **' + descriptor.command + '** - ' + descriptor.description);
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
        
        
        return true;
    }


    // # Module code below this line #


    registerCommand(mod, command, options, callback) {
        if (arguments.length == 2) {
            callback = options;
            options = {};
        }
        if (!options) options = {};
        if (!command || !callback) return false;
        
        var commandid = command.toLowerCase();
        
        var descriptor = {
            modName: mod.modName,
            command: command,
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
        
        var exists = this.getCommand(commandid);
        if (exists) {
            if (exists.modName != mod.modName) {
                this.log('warn', 'Unable to register the command ID "' + commandid + '" because it was previously registered by |' + exists.modName + '|.');
                return false;
            } else {
                exists.callback[mod.name] = callback;
            }
        } else {
            this._commands.push(descriptor);
            this._index[commandid] = descriptor;
        }
        
        this.log('Registered command: ' + this.stripNormalizedFormatting(this.buildCommandSyntax(command))
                + (descriptor.permissions ? ' (permissions: ' + (descriptor.requireAllPermissions ? 'all of ' : 'any of ') + descriptor.permissions.join(', ') + ')' : ''));
        
        return true;
    }
    
    unregisterCommand(command) {
        var commandid = command.toLowerCase();
        if (!this.getCommand(commandid)) return false;
        
        this._commands = this._commands.filter((descriptor) => (descriptor.command.toLowerCase() != commandid));
        if (this._index[commandid]) delete this._index[commandid];
        
        this.log('Unregistered command: ' + command);
        
        return true;
    }

    getCommand(command) {
        if (!command) return null;
        return this._index[command.toLowerCase()];
    }


    //Event handler

    onCommandMessage(env, type, message, authorid, channelid, rawobject) {

        var prefix = this.param('defaultprefix');
        var prefixes = this.param('prefixes');
        if (prefixes[env.name]) prefix = prefixes[env.name];
        if (!message.startsWith(prefix)) return;
        
        var parts = message.substr(prefix.length);
        parts = parts.trim().split(/ +/);
        var command = parts[0].toLowerCase();
        var args = parts.slice(1);

        if (!this._index[command]) return;
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
            if (!this.mod('Users').testPermissions(env.name, authorid, descriptor.permissions, descriptor.requireAllPermissions, handle)) {
                this.eventLog(env, authorid, channelid, 'FAILED ' + descriptor.command + ': Failed permission check.');
                return true;
            }
        }
        
        
        var targetmod = null;
        if (args[0] && args[0].match(/^|.+|$/)) {
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
                env.msg(authorid, env.applyFormatting(baseerror + '; Please choose one of: ' + knownmods.join(', ')));
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
                env.msg(authorid, env.applyFormatting("Syntax: " + prefix + this.buildCommandSyntax(command)));
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
                env.msg(authorid, env.applyFormatting("Syntax: " + prefix + this.buildCommandSyntax(command)));
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


}


module.exports = ModCommands;
