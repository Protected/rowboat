/* Module: Commands -- Framework for providing responses to triggers in a standardized format. */

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
    }


    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;

        if (!this.param('allowedenvs')) {
            this._params['allowedenvs'] = Object.keys(envs);
        }

        
        //Register callbacks
        
        for (let envname of this.param('allowedenvs')) {
            this.env(envname).registerOnMessage(this.onCommandMessage, this);
        }
        
        
        this.registerCommand('help', {
            description: "Obtain a list of commands or information about a specific command.",
            args: ["command"],
            minArgs: 0,
            unobtrusive: true
        }, (env, type, userid, command, args, handle, reply, pub, priv) => {
        
            if (args.command) {
                var descriptor = this._index[args.command.toLowerCase()];
                if (!descriptor) {
                    reply('No such command!');
                    return true;
                }
            
                reply('  ' + this.buildCommandSyntax(descriptor.command));
                reply('    ' + descriptor.description);
                
                if (descriptor.environments) {
                    reply('    Environment(s): ' + descriptor.environments.join(', '));
                }
                
                if (descriptor.types) {
                    reply('    Message type(s): ' + descriptor.types.join(', '));
                }
                
                if (descriptor.permissions) {
                    var permstring = '';
                    if (descriptor.permissions.length == 0) {
                        permstring = 'LOCKED';
                    } else {
                        if (descriptor.permissions.length > 1) {
                            if (descriptor.requireAllPermissions) permstring = 'All of: ';
                            else permstring = 'One of: ';
                        }
                        permstring = permstring + descriptor.permissions.join(', ');
                    }
                    reply('    Permissions required: ' + permstring);
                }
            
            } else {
            
                priv('Available commands (use help COMMAND for more information):');
                
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
                    
                    priv('    ' + descriptor.command + ' - ' + descriptor.description);
                }
            }
        
            return true;
        });
        
        
        this.registerCommand('time', {
            description: "Retrieve the current server time."
        }, (env, type, userid, command, args, handle, reply) => {
        
            reply(moment().format('dddd YYYY-MM-DD HH:mm:ss'));
        
            return true;
        });
        
        
        this.registerCommand('reload', {
            description: "Reload this application. All environments and modules will be reloaded.",
            types: ["private"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, command, args, handle, reply) => {
        
            setTimeout(() => {
                reply('Reloading...');
                this.log('Reloading Rowboat by request from ' + handle + ' in ' + env.name);
                
                if (!this.mod('root').loadMasterConfig()) {
                    reply('Failed to load master config.');
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


    registerCommand(command, options, callback) {
        if (arguments.length == 2) {
            callback = options;
            options = {};
        }
        if (!options) options = {};
        if (!command || !callback) return false;
        
        var commandid = command.toLowerCase();
        if (this.getCommand(commandid)) return false;
        
        var descriptor = {
            command: command,
            callback: callback,                 //callback(env, type, userid, command, args, handle, reply, pub, priv)
                                                //  -- userid is the environment-side id; args is a list; handle is from ModUsers; reply/pub/priv are functions for context, public and private reply respectively.
            args: [],                           //List of argument names. If the last element of the list is the boolean 'true', all additional arguments will be listed in the previous argument.
            minArgs: null,                      //Minimum amount of arguments that must be passed for the callback to be invoked, or 'null' for all arguments.
            description: "",                    //Description for the new command displayed by the help command.
            environments: null,                 //List of environment names the command can be invoked from, or null for all loaded environments.
            types: null,                        //List of message types the command can be invoked from, or null for all message types (onMessage environment callback only).
            permissions: null,                  //List of individual sufficient permissions required for invoking this command, or null for universal use (only null allows users without accounts to invoke the command).
            requireAllPermissions: false,       //If this boolean is true, the above list becomes a list of necessary permissions (all listed permissions will be simultaneously required).
            unobtrusive: false                  //If this boolean is true, priv will send a notice rather than a message.
        }
        
        if (options) {
            if (options.args) descriptor.args = options.args;
            if (options.minArgs !== undefined) descriptor.minArgs = options.minArgs;
            if (options.description) descriptor.description = options.description;
            if (options.environments) descriptor.environments = options.environments;
            if (options.types) descriptor.types = options.types;
            if (options.permissions) descriptor.permissions = options.permissions;
            if (options.requireAllPermissions) descriptor.requireAllPermissions = options.requireAllPermissions;
            if (options.unobtrusive) descriptor.unobtrusive = options.unobtrusive;
        }
        
        this._commands.push(descriptor);
        this._index[commandid] = descriptor;
        
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
                return true;
            }
        }
        
        if (typeof descriptor.minArgs != "number") {
            descriptor.minArgs = descriptor.args.length;
            if (descriptor.args[descriptor.args.length - 1] === true) {
                descriptor.minArgs -= 1;
            }
        }

        if (args.length < descriptor.minArgs) {
            if (descriptor.unobtrusive) {
                env.notice(authorid, "Syntax: " + prefix + this.buildCommandSyntax(command));
            } else {
                env.msg(authorid, "Syntax: " + prefix + this.buildCommandSyntax(command));
            }
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
        
        if (!descriptor.callback(env, type, authorid, command, passargs, handle,
            function(msg) {
                env.msg(channelid, msg);
            },
            function(msg) {
                env.msg((channelid == authorid ? null : channelid), msg);
            },
            function(msg) {
                if (descriptor.unobtrusive) {
                    env.notice(authorid, msg);
                } else {
                    env.msg(authorid, msg);
                }
            }
        )) {
            if (descriptor.unobtrusive) {
                env.notice(authorid, "Syntax: " + prefix + this.buildCommandSyntax(command));
            } else {
                env.msg(authorid, "Syntax: " + prefix + this.buildCommandSyntax(command));
            }
        }

        return true;
    }


    //Helper functions for... help

    buildCommandSyntax(command) {
        if (!this._index[command]) return "";
        var descriptor = this._index[command];
        var syntax = command;
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
                syntax += descriptor.args[i].toUpperCase();
            }
        }
        if (optionals) syntax += ']';
        return syntax;
    }


}


module.exports = ModCommands;
