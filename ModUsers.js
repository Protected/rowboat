/* Module: Users -- Manage "known" user accounts and permission flags. */

var Module = require('./Module.js');

var PERM_ADMIN = 'administrator';
var PERM_MOD = 'moderator';

class ModUsers extends Module {


    get optionalParams() { return [
        'datafile'
    ]; }

    constructor(name) {
        super('Users', name);
        
        this._params['datafile'] = null;
        
        this._userdata = [];
        this._userhandles = {};
        this._permissionProviders = [];
    }


    initialize(opt) {
        if (!super.initialize(opt)) return false;
       
        //Load data
        
        this._userdata = this.loadData(null, []);
        if (this._userdata === false) return false;
        
        this._userhandles = {};
        for (let eachuser of this._userdata) {
            this._userhandles[eachuser.handle] = eachuser;
        }

        
        //Register callbacks
        
        opt.moduleRequest('Commands', (commands) => {
        
        
            commands.registerRootDetails(this, 'user', {description: "View and manipulate user accounts."});
            commands.registerRootDetails(this, 'id', {description: "Manipulate identification patterns associated with user accounts."});
            commands.registerRootDetails(this, 'perm', {description: "View and manipulate permissions associated with user accounts."});
        
        
            commands.registerCommand(this, 'user add', {
                args: ["handle"],
                description: "Create a new empty user account with the given handle.",
                permissions: [PERM_ADMIN]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                if (this.addUser(args.handle)) {
                    ep.reply("The account " + args.handle + " was successfuly created.");
                } else {
                    ep.reply("There already exists an account identified by " + args.handle + "!");
                }
                
                return true;
            });
            
            
            commands.registerCommand(this, 'user del', {
                args: ["handle"],
                description: "Delete an existing user account identified by the given handle.",
                permissions: [PERM_ADMIN]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                if (this.delUser(args.handle)) {
                    ep.reply("The account " + args.handle + " was successfully deleted.");
                } else {
                    ep.reply("I could not find an account identified by " + args.handle + "!");
                }
                
                return true;
            });
            
            
            commands.registerCommand(this, 'user rename', {
                args: ["fromhandle", "tohandle"],
                description: "Rename an existing account.",
                permissions: [PERM_ADMIN]
            }, (env, type, userid, channelid, command, args, handle, ep) => {

                if (this.renameUser(args.fromhandle, args.tohandle)) {
                    ep.reply("The account " + args.fromhandle + " was successfuly renamed to " + args.tohandle + ".");
                } else{
                    ep.reply("The account " + args.fromhandle + " could not be renamed.");
                }

                return true;
            });


            commands.registerCommand(this, 'id add', {
                args: ["handle", "environment", "idpattern"],
                description: "Add an ID pattern (regex) to authenticate the user account identified by the handle in the specified environment.",
                permissions: [PERM_ADMIN]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                args.idpattern = "^" + args.idpattern + "$";
                if (!this._environments[args.environment]) {
                    ep.reply("There is no environment named " + args.environment + " at this time.");
                    return true;
                }
                
                if (this.addId(args.handle, args.environment, args.idpattern)) {
                    ep.reply("Successfully added the requested pattern to the account identified by " + args.handle + ".");
                } else {
                    ep.reply("I could not find an account identified by " + args.handle + "!");
                }
                
                return true;
            });
            
            
            commands.registerCommand(this, 'id del', {
                args: ["handle", "environment", "idpattern"],
                description: "Remove an existing ID pattern from a user such that it will no longer authenticate the user account identified by the handle.",
                permissions: [PERM_ADMIN]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
                
                args.idpattern = "^" + args.idpattern + "$";
                
                if (this.delId(args.handle, args.environment, args.idpattern)) {
                    ep.reply("Successfully removed the requested pattern from the account identified by " + args.handle + ".");
                } else {
                    ep.reply("I could not find an account identified by " + args.handle + "!");
                }
                
                return true;
            });
            
            
            commands.registerCommand(this, 'perm add', {
                args: ["handle", "permissions", true],
                minArgs: 2,
                description: "Add one or more permissions to the user account identified by the handle.",
                permissions: [PERM_ADMIN]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                if (this.addPerms(args.handle, args.permissions)) {
                    ep.reply("The permissions listed were added to the account identified by " + args.handle + ".");
                } else {
                    ep.reply("I could not find an account identified by " + args.handle + "!");
                }
            
                return true;
            });
            
            
            commands.registerCommand(this, 'perm del', {
                args: ["handle", "permissions", true],
                minArgs: 2,
                description: "Remove one or more permissions from the user account identified by the handle.",
                permissions: [PERM_ADMIN]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                if (this.delPerms(args.handle, args.permissions)) {
                    ep.reply("The permissions listed were removed from the account identified by " + args.handle + ".");
                } else {
                    ep.reply("I could not find an account identified by " + args.handle + "!");
                }
            
                return true;
            });
            
            
            commands.registerCommand(this, 'user find', {
                args: ["environment", "id"],
                description: "List the handles of the user accounts that match the given id and environment.",
                permissions: [PERM_ADMIN, PERM_MOD]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                var handles = this.getHandlesById(args.environment, args.id);
                if (!handles.length) {
                    ep.reply("No handles were found matching the given environment and id.");
                    return true;
                }
                
                while(handles.length) {
                    var outbound = handles.slice(0, 10);
                    outbound = '"' + outbound.join('","') + '"';
                    ep.reply(outbound);
                    handles = handles.slice(10);
                }
            
                return true;
            });
            
            
            commands.registerCommand(this, 'user list', {
                args: ["perms", true],
                minArgs: 0,
                description: "Lists the handles of the user accounts that have the given permissions.",
                permissions: [PERM_ADMIN, PERM_MOD]
            }, (env, type, userid, channelid, command, args, handle, ep) => {

                var handles = this.getHandlesByPerms(args.perms);
                if (!handles.length) {
                    ep.reply("No handles were found with the given permission" + (args.perms.length != 1 ? "s" : "") + ".");
                    return true;
                }

                while(handles.length) {
                    var outbound = handles.slice(0, 10);
                    outbound = '"' + outbound.join('","') + '"';
                    ep.reply(outbound);
                    handles = handles.slice(10);
                }

                return true;
            });


            commands.registerCommand(this, 'whois', {
                args: ["handle"],
                description: "Describe the user account identified by the handle.",
                permissions: [PERM_ADMIN, PERM_MOD]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                var account = this.getUser(args.handle);
                if (!account) {
                    ep.reply("I could not find an account identified by " + args.handle + "!");
                    return true;
                }
                
                ep.reply('========== __' + account.handle + '__ ==========');
                
                ep.reply('* ID patterns:');
                if (account.ids) {
                    for (var i = 0; i < account.ids.length; i++) {
                        ep.reply('    {' + account.ids[i].env + '} `' + account.ids[i].idpattern + '`');
                    }
                }
                
                ep.reply('* Permissions:');
                var perms = account.perms;
                if (perms) {
                    while (perms.length) {
                        var outbound = perms.slice(0, 10);
                        outbound = outbound.join(', ');
                        ep.reply('    ' + outbound);
                        perms = perms.slice(10);
                    }
                }
            
                return true;
            });
        
        
        });
        
        return true;
    }
    
    
    // # Module code below this line #


    //User account manipulation (new accounts only have a handle)

    addUser(handle) {
        if (this._userhandles[handle]) return false;
        
        if (!handle.match(/^[0-9a-zA-Z]+$/)) return false;

        var newuser = {
            handle: handle,
            ids: [],
            perms: []
        };
        this._userdata.push(newuser);
        this._userhandles[handle] = newuser;

        this.log(`New user added: ${newuser}`);

        this._userdata.save();
        return true;
    }

    delUser(handle) {
        if (!this._userhandles[handle]) return false;
        
        var i = this._userdata.findIndex(
            (checkuser) => (checkuser.handle == handle)
        );
        
        if (i > -1) this._userdata.splice(i, 1);
        delete this._userhandles[handle];

        this.log(`Deleted user ${handle}`);
        this._userdata.save();
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

        this._userdata.save();
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

        if (changed) this._userdata.save();
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
        
        if (changed) this._userdata.save();
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
        
        if (changed) {
            this._userdata.save();
            this.log(`Successfuly added ${perms} to user ${handle}`);
        }
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
        
        if (changed) {
            this.log(`Successfuly removed ${perms} from user ${handle}`);
            this._userdata.save();
        }
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
    //callback(env, userid, channelid, permissions) -- Return a subset of permissions that the user has (empty for none).
    //  channelid is optional.

    registerPermissionProvider(func, self) {
        this.log('Registering permissions provider. Context: ' + self.constructor.name);
        if (!self) {
            this._permissionProviders.push(func);
        } else {
            this._permissionProviders.push([func, self]);
        }
    }


    testPermissions(env, userid, channelid, permissions, requireall, handle) {  //env is an environment NAME; channelid is optional

        var removeduplicates = {};
        for (let perm of permissions) {
            removeduplicates[perm] = true;
        }

        var ascertained = {};

        //From providers

        for (let provider of this._permissionProviders) {
            let subset = [];
            if (typeof provider == "function") {
                subset = provider.apply(this, [env, userid, channelid, permissions]);
            } else {
                subset = provider[0].apply(provider[1], [env, userid, channelid, permissions]);
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
