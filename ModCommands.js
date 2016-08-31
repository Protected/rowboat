/* Module: Commands -- Framework for providing responses to triggers in a standardized format. */

var jsonfile = require('jsonfile');
var moment = require('moment');

//== Module settings (commands.mod.json)

//Default prefix for commands
var defaultprefix = '!';

//List of environments to activate this module on
var allowedenvs = null;

//Per-environment, per-source command prefixes
var prefixes = {};

//==

var environments = null;
var modules = null;
var commands = [];
var index = {};


var PERM_ADMIN = 'administrator';


var modname = "Commands";
exports.name = modname;
exports.rootaccess = true;


exports.requiredenvironments = [];
exports.requiredmodules = ["Users"];


exports.initialize = function(envs, mods, moduleRequest) {

    //Load parameters

    var params = {};
    try {
        params = jsonfile.readFileSync("commands.mod.json");
    } catch(e) {}
    
    if (params.defaultprefix) defaultprefix = params.defaultprefix;
    if (params.prefixes) prefixes = params.prefixes;
    
    if (!allowedenvs) {
        allowedenvs = Object.keys(envs);
    }

    if (!envs) return false;
    environments = envs;
    modules = mods;
        
    
    //Register callbacks
    
    for (var i = 0; i < allowedenvs.length; i++) {
        envs[allowedenvs[i]].registerOnMessage(onCommandMessage);
    }
    
    
    registerCommand('help', {
        description: "Obtain a list of commands or information about a specific command.",
        args: ["command"],
        minArgs: 0
    }, function(env, type, userid, command, args, handle, reply) {
    
        if (args.command) {
            var descriptor = index[args.command.toLowerCase()];
            if (!descriptor) {
                reply('No such command!');
                return true;
            }
        
            reply('  ' + buildCommandSyntax(descriptor.command));
            reply('    ' + descriptor.description);
            reply('.');
            
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
            
            reply('---');
        
        } else {
        
            reply('Available commands (use help COMMAND for more information):');
            
            for (var i = 0; i < commands.length; i++) {
                var descriptor = commands[i];
                
                if (descriptor.environments && descriptor.environments.indexOf(env) < 0) {
                    continue;
                }
                
                if (descriptor.types && descriptor.types.indexOf(type) < 0) {
                    continue;
                }
                
                var handles = modules.Users.getHandlesById(env, userid, true);
                var handle = (handles.length ? handles[0] : null);
                if (descriptor.permissions) {
                    if (!handle) continue;
                    if (descriptor.requireAllPermissions && !modules.Users.hasAllPerms(handle, descriptor.permissions)) return;
                    if (!descriptor.requireAllPermissions && !modules.Users.hasAnyPerm(handle, descriptor.permissions)) return;
                }
                
                reply('    ' + commands[i].command + ' - ' + commands[i].description);
            }
            
            reply('---');
        }
    
        return true;
    });
    
    
    registerCommand('time', {
        description: "Retrieve the current server time."
    }, function(env, type, userid, command, args, handle, reply) {
    
        reply(moment().format('dddd YYYY-MM-DD HH:mm:ss'));
    
        return true;
    });
    
    
    registerCommand('reload', {
        description: "Reload this application. All environments and modules will be reloaded.",
        types: ["private"],
        permissions: [PERM_ADMIN]
    }, function(env, type, userid, command, args, handle, reply) {
    
        setTimeout(function() {
            reply('Reloading...');
            console.log('Reloading Rowboat by request from ' + handle + ' in ' + env);
            
            if (!modules.root.loadMasterConfig()) {
                reply('Failed to load master config.');
                process.exit(1);
            }
            
            if (!modules.root.loadEnvironments()) {
                reply('Failed to load environments.');
                process.exit(1);
            }
            
            if (!modules.root.loadModules()) {
                reply('Failed to load modules.');
                process.exit(1);
            }
            
            if (!modules.root.runEnvironments()) {
                reply('Failed to run environments.');
                process.exit(1);
            }
        
            console.log('Reload successful.');
            reply('Reload ended successfully.');
        }, 1);
    
        return true;
    });
    
    
    return true;
};


// # Module code below this line #


function registerCommand(command, options, callback) {
    if (arguments.length == 2) {
        callback = options;
        options = {};
    }
    if (!options) options = {};
    if (!command || !callback) return false;
    
    var commandid = command.toLowerCase();
    if (getCommand(commandid)) return false;
    
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
    }
    
    if (options) {
        if (options.args) descriptor.args = options.args;
        if (options.minArgs !== undefined) descriptor.minArgs = options.minArgs;
        if (options.description) descriptor.description = options.description;
        if (options.environments) descriptor.environments = options.environments;
        if (options.types) descriptor.types = options.types;
        if (options.permissions) descriptor.permissions = options.permissions;
        if (options.requireAllPermissions) descriptor.requireAllPermissions = options.requireAllPermissions;
    }
    
    commands.push(descriptor);
    index[commandid] = descriptor;
    
    return true;
}

function getCommand(command) {
    if (!command) return null;
    return index[command.toLowerCase()];
}


//Event handler

function onCommandMessage(env, type, message, authorid, channelid, rawobject) {

    var prefix = defaultprefix;
    if (prefixes[env]) prefix = prefixes[env];
    if (!message.startsWith(prefix)) return;
    
    var parts = message.substr(prefix.length);
    parts = parts.trim().split(/ +/);
    var command = parts[0].toLowerCase();
    var args = parts.slice(1);

    if (!index[command]) return;
    var descriptor = index[command];
    
    if (descriptor.environments && descriptor.environments.indexOf(env) < 0) {
        return true;
    }
    
    if (descriptor.types && descriptor.types.indexOf(type) < 0) {
        return true;
    }
    
    var handles = modules.Users.getHandlesById(env, authorid, true);
    var handle = (handles.length ? handles[0] : null);
    if (descriptor.permissions) {
        if (!handle) return true;
        if (descriptor.requireAllPermissions && !modules.Users.hasAllPerms(handle, descriptor.permissions)) return true;
        if (!descriptor.requireAllPermissions && !modules.Users.hasAnyPerm(handle, descriptor.permissions)) return true;
    }
    
    if (args.length < descriptor.minArgs) {
        envionments[env].msg(authorid, "Syntax: " + prefix + buildCommandSyntax(command));
        return true;
    }
    
    var passargs = {};
    for (var i = 0; i < descriptor.args.length; i++) {
        var argname = descriptor.args[i];
        if (i == descriptor.args.length - 2 && descriptor.args[descriptor.args.length - 1] === true) {
            passargs[argname] = args.slice(i);
        } else {
            passargs[argname] = args[i];
        }
    }
    
    if (!descriptor.callback(env, type, authorid, command, passargs, handle,
        function(msg) {
            environments[env].msg(channelid, msg);
        },
        function(msg) {
            environments[env].msg((channelid == authorid ? null : channelid), msg);
        },
        function(msg) {
            environments[env].msg(authorid, msg);
        }
    )) {
        envionments[env].msg(authorid, "Syntax: " + prefix + buildCommandSyntax(command));
    }

    return true;
}


//Helper functions for... help

function buildCommandSyntax(command) {
    if (!index[command]) return "";
    var descriptor = index[command];
    var syntax = command;
    var optionals = false;
    for (var i = 0; i < descriptor.args; i++) {
        syntax += ' ';
        if (minArgs !== null && i == minArgs && descriptor.args[i] !== true) {
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


//Exports for dependent modules

exports.registerCommand = registerCommand;
