/* Module: Users -- Manage "known" user accounts and permission flags. */

var Module = require('./Module.js');
var fs = require('fs');
var jsonfile = require('jsonfile');

var PERM_ADMIN = 'administrator';
var PERM_MOD = 'moderator';

class ModUsers extends Module {


    get optionalParams() { return [
        'datafile'
    ]; }

    constructor(name) {
        super('Users', name);
        
        this._params['datafile'] = 'users.data.json';
        
        this._userdata = [];
        this._userhandles = {};
        this._permissionProviders = [];
    }


    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;
       
        //Load data
        
        if (!this.loadUsers()) return false;

        
        //Register callbacks
        
        moduleRequest('Commands', (commands) => {
        
        
            commands.registerCommand('useradd', {
                args: ["handle"],
                description: "Create a new empty user account with the given handle.",
                types: ["private"],
                permissions: [PERM_ADMIN]
            }, (env, type, userid, command, args, handle, reply) => {
            
                if (this.addUser(args.handle)) {
                    reply("The account " + args.handle + " was successfuly created.");
                } else {
                    reply("There already exists an account identified by " + args.handle + "!");
                }
                
                return true;
            });
            
            
            commands.registerCommand('userdel', {
                args: ["handle"],
                description: "Delete an existing user account identified by the given handle.",
                types: ["private"],
                permissions: [PERM_ADMIN]
            }, (env, type, userid, command, args, handle, reply) => {
            
                if (this.delUser(args.handle)) {
                    reply("The account " + args.handle + " was successfully deleted.");
                } else {
                    reply("I could not find an account identified by " + args.handle + "!");
                }
                
                return true;
            });
            
            
            comands.registerCommand('userrename', {
                args: ["fromhandle", "tohandle"],
                description: "Rename an existing account.",
                types: ["private"],
                permissions: [PERM_ADMIN]
            }, (env, type, userid, command, args, handle, reply) => {
            
                if (this.renameUser(args.fromhandle, args.tohandle)) {
                    reply("The account " + args.fromhandle + " was successfuly renamed to " + args.tohandle + ".");
                } else{
                    reply("The account " + args.fromhandle + " could not be renamed.");
                }
            
                return true;
            });
            
            
            commands.registerCommand('idadd', {
                args: ["handle", "environment", "idpattern"],
                description: "Add an ID pattern (regex) to authenticate the user account identified by the handle in the specified environment.",
                types: ["private"],
                permissions: [PERM_ADMIN]
            }, (env, type, userid, command, args, handle, reply) => {
            
                args.idpattern = "^" + args.idpattern + "$";
                if (!this._environments[args.environment]) {
                    reply("There is no environment named " + args.environment + " at this time.");
                    return true;
                }
                
                if (this.addId(args.handle, args.environment, args.idpattern)) {
                    reply("Successfully added the requested pattern to the account identified by " + args.handle + ".");
                } else {
                    reply("I could not find an account identified by " + args.handle + "!");
                }
                
                return true;
            });
            
            
            commands.registerCommand('iddel', {
                args: ["handle", "environment", "idpattern"],
                description: "Remove an existing ID pattern from a user such that it will no longer authenticate the user account identified by the handle.",
                types: ["private"],
                permissions: [PERM_ADMIN]
            }, (env, type, userid, command, args, handle, reply) => {
                
                args.idpattern = "^" + args.idpattern + "$";
                
                if (this.delId(args.handle, args.environment, args.idpattern)) {
                    reply("Successfully removed the requested patterm from the account identified by " + args.handle + ".");
                } else {
                    reply("I could not find an account identified by " + args.handle + "!");
                }
                
                return true;
            });
            
            
            commands.registerCommand('permadd', {
                args: ["handle", "permissions", true],
                minArgs: 2,
                description: "Add one or more permissions to the user account identified by the handle.",
                permissions: [PERM_ADMIN]
            }, (env, type, userid, command, args, handle, reply) => {
            
                if (this.addPerms(args.handle, args.permissions)) {
                    reply("The permissions listed were added to the account identified by " + args.handle + ".");
                } else {
                    reply("I could not find an account identified by " + args.handle + "!");
                }
            
                return true;
            });
            
            
            commands.registerCommand('permdel', {
                args: ["handle", "permissions", true],
                minArgs: 2,
                description: "Remove one or more permissions from the user account identified by the handle.",
                permissions: [PERM_ADMIN]
            }, (env, type, userid, command, args, handle, reply) => {
            
                if (this.delPerms(args.handle, args.permissions)) {
                    reply("The permissions listed were removed from the account identified by " + args.handle + ".");
                } else {
                    reply("I could not find an account identified by " + args.handle + "!");
                }
            
                return true;
            });
            
            
            commands.registerCommand('userfind', {
                args: ["environment", "id"],
                description: "List the handles of the user accounts that match the given id and environment.",
                types: ["private"],
                permissions: [PERM_ADMIN, PERM_MOD]
            }, (env, type, userid, command, args, handle, reply) => {
            
                var handles = this.getHandlesById(args.environment, args.id);
                if (!handles.length) {
                    reply("No handles were found matching the given environment and id.");
                    return true;
                }
                
                while(handles.length) {
                    var outbound = handles.slice(0, 10);
                    outbound = '"' + outbound.join('","') + '"';
                    reply(outbound);
                    handles = handles.slice(10);
                }
            
                return true;
            });
            
            
            commands.registerCommand('userlist', {
                args: ["perms", true],
                minArgs: 0,
                description: "Lists the handles of the user accounts that have the given permissions.",
                types: ["private"],
                permissions: [PERM_ADMIN, PERM_MOD]
            }, (env, type, userid, command, args, handle, reply) => {
                
                var handles = this.getHandlesByPerms(args.perms);
                if (!handles.length) {
                    reply("No handles were found with the given permission" + (args.perms.length != 1 ? "s" : "") + ".");
                    return true;
                }
                
                while(handles.length) {
                    var outbound = handles.slice(0, 10);
                    outbound = '"' + outbound.join('","') + '"';
                    reply(outbound);
                    handles = handles.slice(10);
                }
            
                return true;
            });
            
            
            commands.registerCommand('whois', {
                args: ["handle"],
                description: "Describe the user account identified by the handle.",
                types: ["private"],
                permissions: [PERM_ADMIN, PERM_MOD]
            }, (env, type, userid, command, args, handle, reply) => {
            
                var account = this.getUser(args.handle);
                if (!account) {
                    reply("I could not find an account identified by " + args.handle + "!");
                    return true;
                }
                
                reply('========== ' + account.handle + ' ==========');
                
                reply('* ID patterns:');
                if (account.ids) {
                    for (var i = 0; i < account.ids.length; i++) {
                        reply('    {' + account.ids[i].env + '} `' + account.ids[i].idpattern + '`');
                    }
                }
                
                reply('* Permissions:');
                var perms = account.perms;
                if (perms) {
                    while (perms.length) {
                        var outbound = perms.slice(0, 10);
                        outbound = outbound.join(', ');
                        reply(outbound);
                        perms = perms.slice(10);
                    }
                }
                
                reply('.');
            
                return true;
            });
        
        
        });
        
        return true;
    }
    
    
    // # Module code below this line #


    //User account manipulation (new accounts only have a handle)

    loadUsers() {
        var datafile = this.param('datafile');
     
        try {
            fs.accessSync(datafile, fs.F_OK);
        } catch (e) {
            jsonfile.writeFileSync(datafile, []);
        }

        try {
            this._userdata = jsonfile.readFileSync(datafile);
        } catch (e) {
            return false;
        }
        if (!this._userdata) this._userdata = [];
        
        this._userhandles = {};
        for (let eachuser of this._userdata) {
            this._userhandles[eachuser.handle] = eachuser;
        }
        
        return true;
    }

    saveUsers() {
        var datafile = this.param('datafile');
        
        jsonfile.writeFileSync(datafile, this._userdata);
    }


    addUser(handle) {
        if (this._userhandles[handle]) return false;

        var newuser = {
            handle: handle,
            ids: [],
            perms: []
        }
        this._userdata.push(newuser);
        this._userhandles[handle] = newuser;
        
        this.saveUsers();
        return true;
    }

    delUser(handle) {
        if (!this._userhandles[handle]) return false;
        
        var i = this._userdata.findIndex(
            (checkuser) => (checkuser.handle == handle)
        );
        
        if (i > -1) this._userdata.splice(i, 1);
        delete this._userhandles[handle];
        
        this.saveUsers();
        return true;
    }

    getUser(handle) {
        return this._userhandles[handle];
    }
    
    renameUser(fromhandle, tohandle) {
        var desc = this._userhandles[fromhandle];
        if (!desc) return false;
        if (this._userhandles[tohandle]) return false;
        
        desc.handle = tohandle;
        delete this._userhandles[fromhandle];
        this._userhandles[tohandle] = desc;
        
        this.saveUsers();
        return true;
    }


    //User ID manipulation - Identify a user in a specific environment as being the owner of the account. idpattern matches the environment's authorid/targetid.

    addId(handle, env, idpattern) {
        if (!env || !idpattern) return false;
        
        var changed = false;
        var chuser = this.getUser(handle);
        if (!chuser) return false;

        if (!chuser.ids.find(
            (id) => (id.env == env && id.idpattern == idpattern)
        )) {
            chuser.ids.push({env: env, idpattern: idpattern});
            changed = true;
        }

        if (changed) this.saveUsers();
        return true;
    }

    delId(handle, env, idpattern) {
        if (!env) return false;
        
        var changed = false;
        var chuser = this.getUser(handle);
        if (!chuser) return false;
        
        for (var i = 0; i < chuser.ids.length; i++) {
            if (chuser.ids[i].env != env) continue;
            if (idpattern && chuser.ids[i].idpattern != idpattern) continue;
            chuser.ids.splice(i, 1);
            changed = true;
            i -= 1;
        }
        
        if (changed) this.saveUsers();
        return true;
    }

    getIds(handle, env) {
        var chuser = this.getUser(handle);
        if (!chuser) return [];
        
        if (!env) return chuser.ids;
        
        return chuser.ids.map(
            (item) => (item.env == env ? item.idpattern : null)
        ).filter(
            (idpattern) => (idpattern != null)
        );
    }

    isIdHandle(handle, env, id, strict) {
        if (strict) {
            if (!this._environments[env].idIsSecured(id) || !this._environments[env].idIsAuthenticated(id)) {
                return false;
            }
        }
        
        var ids = this.getIds(handle, env);
        
        for (let eachid of ids) {
            if (RegExp(eachid).exec(id)) {
                return true;
            }
        }
        
        return false;
    }

    getHandlesById(env, id, strict) {
        var result = [];
        
        for (let eachuser of this._userdata) {
            if (this.isIdHandle(eachuser.handle, env, id, strict)) {
                result.push(eachuser.handle);
            }
        }

        return result;
    }


    //Permission manipulation - A permission is a literal which the user may have or not. Permissions are meaningless unless used by other modules.

    addPerms(handle, perms) {
        if (!perms) return false;
        
        var changed = false;
        var chuser = this.getUser(handle);
        if (!chuser) return false;
        
        for (let perm of perms) {
            perm = perm.toLowerCase();
            if (!chuser.perms.find((checkperm) => (checkperm == perm))) {
                chuser.perms.push(perm);
                changed = true;
            }
        }
        
        if (changed) this.saveUsers();
        return true;
    }

    delPerms(handle, perms) {
        if (!perms) return false;
        
        var changed = false;
        var chuser = this.getUser(handle);
        if (!chuser) return false;
        
        for (let perm of perms) {
            perm = perm.toLowerCase();
            var ind = chuser.perms.findIndex((checkperm) => (checkperm == perm));
            if (ind > -1) {
                chuser.perms.splice(ind, 1);
                changed = true;
            }
        }
        
        if (changed) this.saveUsers();
        return true;
    }

    getPerms(handle) {
        var checkuser = this.getUser(handle);
        if (!checkuser) return [];
        return checkuser.perms;
    }

    hasAllPerms(handle, perms) {
        var checkuser = this.getUser(handle);
        if (!checkuser) return false;
        for (let perm of perms) {
            perm = perm.toLowerCase();
            if (!checkuser.perms.find((checkperm) => (checkperm == perm))) {
                return false;
            }
        }
        return true;
    }

    hasAnyPerm(handle, perms) {
        var checkuser = this.getUser(handle);
        if (!checkuser) return false;
        for (let perm of perms) {
            perm = perm.toLowerCase();
            if (checkuser.perms.find((checkperm) => (checkperm == perm))) {
                return true;
            }
        }
        return false;
    }
    
    subsetPerms(handle, perms) {
        var checkuser = this.getUser(handle);
        if (!checkuser) return false;
        var subset = [];
        for (let perm of perms) {
            if (checkuser.perms.find((checkperm) => (checkperm == perm.toLowerCase()))) {
                subset.push(perm);
            }
        }
        return subset;
    }
    
    getHandlesByPerms(perms) {
        var result = [];
        
        for (let eachuser of this._userdata) {
            if (this.hasAllPerms(eachuser.handle, perms)) {
                result.push(eachuser.handle);
            }
        }

        return result;
    }
    
    
    //Programmatic permission providers (not persisted)
    //callback(env, userid, permissions) -- Return a subset of permissions that the user has (empty for none).
 
    registerPermissionProvider(func, self) {
        console.log('Registering permissions provider. Context: ' + self.constructor.name);
        if (!self) {
            this._permissionProviders.push(func);
        } else {
            this._permissionProviders.push([func, self]);
        }
    }
    
    
    testPermissions(env, userid, permissions, requireall, handle) {
    
        var removeduplicates = {};
        for (let perm of permissions) {
            removeduplicates[perm] = true;
        }
    
        var ascertained = {};
    
        //From providers
    
        for (let provider of this._permissionProviders) {
            let subset = [];
            if (typeof provider == "function") {
                subset = provider.apply(this, [env, userid, permissions]);
            } else {
                subset = provider[0].apply(provider[1], [env, userid, permissions]);
            }
            for (let perm of subset) {
                ascertained[perm] = true;
            }
        }
        
        //From account
    
        var handles = this.getHandlesById(env, userid, true);
        if (!handle) {
            handle = (handles.length ? handles[0] : null);
        } else {
            let confirmed = false;
            for (let checkhandle of handles) {
                if (checkhandle == handle) {
                    confirmed = true;
                    break;
                }
            }
            if (!confirmed) handle = null;
        }
        
        if (handle) {
            for (let perm of this.subsetPerms(handle, permissions)) {
                ascertained[perm] = true;
            }
        }
        
        //Result
        
        return (!requireall && Object.keys(ascertained).length
                || requireall && Object.keys(ascertained).length == Object.keys(removeduplicates).length);
        
    }
    
    
}


module.exports = ModUsers;
