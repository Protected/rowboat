import Behavior from '../src/Behavior.js';

export default class Users extends Behavior {

    get description() { return "Manage \"known\" user accounts and permission flags"; }

    get params() { return [
        {n: 'datafile', d: "Customize the name of the default data file"},
        {n: 'bootstrap', d: "Provides static permissions when setting up {handle, environment, idpattern, [permissions...]}"},
        {n: 'defaultpermadmin', d: "A default permission name behaviors can use for gating admin (full permissions) features."},
        {n: 'defaultpermmod', d: "A default permission name behaviors can use for gating moderator features."},
    ]; }

    get defaults() { return {
        datafile: null,
        bootstrap: null,
        defaultpermadmin: 'administrator',
        defaultpermmod: 'moderator'
    }; }

    get optionalBehaviors() { return {
        Commands: "Commands"
    }; }

    constructor(name) {
        super('Users', name);
        
        this._envExists = null;
        this._envProxy = null;

        this._userdata = [];
        this._userhandles = {};
        this._permissionProviders = [];
    }


    get defaultPermAdmin() { return this.param("defaultpermadmin"); }
    get defaultPermMod() { return this.param("defaultpermmod"); }


    initialize(opt) {
        if (!super.initialize(opt)) return false;
       
        this._envProxy = opt.envProxy;
        this._envExists = opt.envExists;

        //Load data
        
        this._userdata = this.loadData(null, []);
        if (this._userdata === false) return false;
        
        this._userhandles = {};
        for (let eachuser of this._userdata) {
            this._userhandles[eachuser.handle] = eachuser;
        }


        //Bootstrap

        let bootstrap = this.param("bootstrap");
        if (bootstrap && typeof bootstrap === "object") {
            let warning = "!!WARNING!! Behavior " + this._name + " is running with bootstrap permissions for " + bootstrap.handle + ", identified by: {" + bootstrap.environment + "} " + bootstrap.idpattern + " . Remove and restart before normal use.";
            console.log(warning);
            this.log("warn", warning);

            this.addUser(bootstrap.handle);
            this.addId(bootstrap.handle, bootstrap.environment, bootstrap.idpattern);
            this.addPerms(bootstrap.handle, bootstrap.permissions);
        }

        
        //Register callbacks

        if (this.optBeExists("Commands")) {
            const commands = this.be("Commands");
        
            commands.registerRootDetails(this, 'user', {description: "View and manipulate user accounts."});
            commands.registerRootDetails(this, 'id', {description: "Manipulate identification patterns associated with user accounts."});
            commands.registerRootDetails(this, 'perm', {description: "View and manipulate permissions associated with user accounts."});
            commands.registerRootDetails(this, 'meta', {description: "View and manipulate metadata associated with user accounts."});
        
        
            commands.registerCommand(this, 'user add', {
                args: ["handle"],
                description: "Create a new empty user account with the given handle.",
                permissions: [this.defaultPermAdmin]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                if (this.addUser(args.handle)) {
                    ep.reply("The account " + args.handle + " was successfuly created.");
                } else {
                    ep.reply("There already exists an account identified by " + args.handle + "!");
                }
                
                return true;
            });
            
            
            commands.registerCommand(this, 'user create', {
                args: ["user", "handle"],
                minArgs: 1,
                description: "Create a user account for the given user in the current environment with the given handle.",
                permissions: [this.defaultPermAdmin]
            }, async (env, type, userid, channelid, command, args, handle, ep) => {
            
                let targetid = await env.displayNameToId(args.user);
                if (!targetid) {
                    ep.reply("There is no such user.");
                    return true;
                }
            
                let handles = await this.getHandlesById(env.name, targetid);
                let checkhandle = (handles.length ? handles[0] : null);
                if (checkhandle) {
                    ep.reply("This user already has an account: " + checkhandle + ".");
                    return true;
                }
                
                let wanthandle = args.handle;
                if (!wanthandle) wanthandle = await this.handleSuggestion(env.name, targetid);
                
                if (!wanthandle || !wanthandle.match(/^[0-9a-zA-Z]+$/)) {
                    ep.reply("The handle '" + wanthandle + "' is invalid. Please provide a handle with only alphanumeric characters in it.");
                    return true;
                }
                
                let existingaccount = this.getUser(wanthandle);
                if (existingaccount) {
                    ep.reply("There is already an account identified by the handle '" + wanthandle + "'.");
                    return true;
                }
                
                if (!this.addUser(wanthandle)) {
                    ep.reply("Failed to create user account '" + wanthandle + "'.");
                    return true;
                }
                
                if (!this.addId(wanthandle, env.name, "^" + targetid + "$")) {
                    this.delUser(wanthandle);
                    ep.reply("Failed to initialize the new account with the user's " + env.name + " ID.");
                    return true;
                }
                
                ep.reply("The account '" + wanthandle + "' was successfully created!");
                
                return true;
            });
            
            
            commands.registerCommand(this, 'user del', {
                args: ["handle"],
                description: "Delete an existing user account identified by the given handle.",
                permissions: [this.defaultPermAdmin]
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
                permissions: [this.defaultPermAdmin]
            }, (env, type, userid, channelid, command, args, handle, ep) => {

                if (this.renameUser(args.fromhandle, args.tohandle)) {
                    ep.reply("The account " + args.fromhandle + " was successfuly renamed to " + args.tohandle + ".");
                } else{
                    ep.reply("The account " + args.fromhandle + " could not be renamed.");
                }

                return true;
            });
            
            
            commands.registerCommand(this, 'user find', {
                args: ["environment", "id"],
                description: "List the handles of the user accounts that match the given id and environment.",
                permissions: [this.defaultPermAdmin, this.defaultPermMod]
            }, async (env, type, userid, channelid, command, args, handle, ep) => {
            
                let handles = await this.getHandlesById(args.environment, args.id);
                if (!handles.length) {
                    ep.reply("No handles were found matching the given environment and id.");
                    return true;
                }
                
                while (handles.length) {
                    let outbound = handles.slice(0, 10);
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
                permissions: [this.defaultPermAdmin, this.defaultPermMod]
            }, (env, type, userid, channelid, command, args, handle, ep) => {

                let handles = this.getHandlesByPerms(args.perms);
                if (!handles.length) {
                    ep.reply("No handles were found with the given permission" + (args.perms.length != 1 ? "s" : "") + ".");
                    return true;
                }

                while (handles.length) {
                    let outbound = handles.slice(0, 10);
                    outbound = '"' + outbound.join('","') + '"';
                    ep.reply(outbound);
                    handles = handles.slice(10);
                }

                return true;
            });


            commands.registerCommand(this, 'id add', {
                args: ["handle", "environment", "idpattern"],
                description: "Add an ID pattern (regex) to authenticate the user account identified by the handle in the specified environment.",
                permissions: [this.defaultPermAdmin]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                args.idpattern = "^" + args.idpattern + "$";
                if (!this._envExists(args.environment)) {
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
                permissions: [this.defaultPermAdmin]
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
                permissions: [this.defaultPermAdmin]
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
                permissions: [this.defaultPermAdmin]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                if (this.delPerms(args.handle, args.permissions)) {
                    ep.reply("The permissions listed were removed from the account identified by " + args.handle + ".");
                } else {
                    ep.reply("I could not find an account identified by " + args.handle + "!");
                }
            
                return true;
            });
            
            
            commands.registerCommand(this, 'meta set', {
                args: ["handle", "key", "value", true],
                minArgs: 2,
                description: "Set a metadata key in the user account identified by the handle.",
                permissions: [this.defaultPermAdmin]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                let value = args.value.join(" ");
            
                if (this.setMeta(args.handle, args.key, value)) {
                    ep.reply("Metadata key set in the account identified by " + args.handle + ".");
                } else {
                    ep.reply("I could not find an account identified by " + args.handle + " or erroneous arguments.");
                }
            
                return true;
            });
            
            
            commands.registerCommand(this, 'meta del', {
                args: ["handle", "key"],
                description: "Unset a metadata key in the user account identified by the handle.",
                details: [
                    "Note that removing keys created by modules may impact module functionality."
                ],
                permissions: [this.defaultPermAdmin]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                if (this.delMeta(args.handle, args.key)) {
                    ep.reply("Metadata key removed from the account identified by " + args.handle + ".");
                } else {
                    ep.reply("I could not find an account identified by " + args.handle + " or erroneous key.");
                }
            
                return true;
            });
            
            
            commands.registerCommand(this, 'meta get', {
                args: ["handle", "key"],
                description: "Read a metadata key from the user account identified by the handle.",
                permissions: [this.defaultPermAdmin]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                let value = this.getMeta(args.handle, args.key);
                if (value === undefined) {
                    ep.reply("Key not found in the account identified by " + args.handle + ".");
                } else {
                    ep.reply(args.key + " = '" + value + "'");
                }
            
                return true;
            });


            commands.registerCommand(this, 'whois', {
                args: ["handle", "full"],
                minArgs: 1,
                description: "Describe the user account identified by the handle.",
                permissions: [this.defaultPermAdmin, this.defaultPermMod]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                let account = this.getUser(args.handle);
                if (!account) {
                    ep.reply("I could not find an account identified by " + args.handle + "!");
                    return true;
                }
                
                ep.reply('========== __' + account.handle + '__ ==========');
                
                ep.reply('* ID patterns:');
                if (account.ids) {
                    for (let i = 0; i < account.ids.length; i++) {
                        ep.reply('    {' + account.ids[i].env + '} `' + account.ids[i].idpattern + '`');
                    }
                }
                
                ep.reply('* Permissions:');
                let perms = account.perms;
                if (perms) {
                    while (perms.length) {
                        let outbound = perms.slice(0, 10);
                        outbound = outbound.join(', ');
                        ep.reply('    ' + outbound);
                        perms = perms.slice(10);
                    }
                }
                
                if (args.full && account.meta) {
                    ep.reply('* Metadata:');
                    let keys = Object.keys(account.meta);
                    for (let key of keys) {
                        ep.reply('    ' + key + " = '" + account.meta[key] + "'");
                    }
                }
            
                return true;
            });
        
        
        }
        
        return true;
    }
    
    
    // # Module code below this line #


    //User account manipulation (new accounts only have a handle)

    async handleSuggestion(env, userid) {
        let getenv = this._envProxy(env);
        if (!getenv) return null;
        let wanthandle = await getenv.idToDisplayName(userid);
        if (wanthandle) {
            wanthandle = wanthandle
                .replace(/\[[^\]]*\]/g, "")
                .replace(/\([^)]*\)/g, "")
                .replace(/\{[^}]*\}/g, "")
                .replace(/[^0-9a-zA-Z]/g, "")
                ;
        }
        return wanthandle;
    }

    async getEnvUser(env, userid) {  //Implicit registration
        let handles = await this.getHandlesById(env, userid, true);
        if (handles.length) return this.getUser(handles[0]);

        let handle = await this.handleSuggestion(env, userid);
        if (!handle) return null;

        let user = this.getUser(handle);
        if (user) return null;

        if (!this.addUser(handle)) return null;
        user = this.getUser(handle);

        if (!this.addId(handle, env, "^" + userid + "$")) {
            this.delUser(handle);
            return null;
        }

        return user;
    }

    addUser(handle) {
        if (this._userhandles[handle]) return false;
        
        if (!handle.match(/^[0-9a-zA-Z]+$/)) return false;

        let newuser = {
            handle: handle,
            ids: [],
            perms: [],
            meta: {}
        };
        this._userdata.push(newuser);
        this._userhandles[handle] = newuser;

        this.log(`New user added: ${newuser}`);

        this._userdata.save();
        return true;
    }

    delUser(handle) {
        if (!this._userhandles[handle]) return false;
        
        let i = this._userdata.findIndex(checkuser => checkuser.handle == handle);
        
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
        let desc = this._userhandles[fromhandle];
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
        
        let changed = false;
        let chuser = this.getUser(handle);
        if (!chuser) return false;

        if (!chuser.ids.find(id => id.env == env && id.idpattern == idpattern)) {
            chuser.ids.push({env: env, idpattern: idpattern});
            changed = true;
        }

        if (changed) this._userdata.save();
        return true;
    }

    delId(handle, env, idpattern) {
        if (!env) return false;
        
        let changed = false;
        let chuser = this.getUser(handle);
        if (!chuser) return false;
        
        for (let i = 0; i < chuser.ids.length; i++) {
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
        let chuser = this.getUser(handle);
        if (!chuser) return [];
        
        if (!env) return chuser.ids;
        
        return chuser.ids.map(
            (item) => (item.env == env ? item.idpattern : null)
        ).filter(
            (idpattern) => (idpattern != null)
        );
    }

    async isIdHandle(handle, env, id, strict) {
        if (strict) {
            if (!await this._envProxy(env).idIsSecured(id)) return false;
            if (!await this._envProxy(env).idIsAuthenticated(id)) return false;
        }
        
        let ids = this.getIds(handle, env);
        
        for (let eachid of ids) {
            if (RegExp(eachid).exec(id)) {
                return true;
            }
        }
        
        return false;
    }

    async getHandlesById(env, id, strict) {
        let result = [];
        
        for (let eachuser of this._userdata) {
            if (await this.isIdHandle(eachuser.handle, env, id, strict)) {
                result.push(eachuser.handle);
            }
        }

        return result;
    }


    //Permission manipulation - A permission is a literal which the user may have or not. Permissions are meaningless unless used by other modules.

    addPerms(handle, perms) {
        if (!perms) return false;
        
        let changed = false;
        let chuser = this.getUser(handle);
        if (!chuser) return false;
        
        for (let perm of perms) {
            perm = perm.toLowerCase();
            if (!chuser.perms.find(checkperm => checkperm == perm)) {
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
        
        let changed = false;
        let chuser = this.getUser(handle);
        if (!chuser) return false;
        
        for (let perm of perms) {
            perm = perm.toLowerCase();
            let ind = chuser.perms.findIndex(checkperm => checkperm == perm);
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
        let checkuser = this.getUser(handle);
        if (!checkuser) return [];
        return checkuser.perms;
    }

    hasAllPerms(handle, perms) {
        let checkuser = this.getUser(handle);
        if (!checkuser) return false;
        for (let perm of perms) {
            perm = perm.toLowerCase();
            if (!checkuser.perms.find(checkperm => checkperm == perm)) {
                return false;
            }
        }
        return true;
    }

    hasAnyPerm(handle, perms) {
        let checkuser = this.getUser(handle);
        if (!checkuser) return false;
        for (let perm of perms) {
            perm = perm.toLowerCase();
            if (checkuser.perms.find(checkperm => checkperm == perm)) {
                return true;
            }
        }
        return false;
    }

    subsetPerms(handle, perms) {
        let checkuser = this.getUser(handle);
        if (!checkuser) return false;
        let subset = [];
        for (let perm of perms) {
            if (checkuser.perms.find(checkperm => checkperm == perm.toLowerCase())) {
                subset.push(perm);
            }
        }
        return subset;
    }

    getHandlesByPerms(perms) {
        let result = [];

        for (let eachuser of this._userdata) {
            if (this.hasAllPerms(eachuser.handle, perms)) {
                result.push(eachuser.handle);
            }
        }

        return result;
    }
    
    
    //Metadata manipulation - Data associated with user accounts. Metadata is meaningless unless used by other modules.
    
    setMeta(handle, key, value) {
        if (!key) return false;
        
        let changed = false;
        let chuser = this.getUser(handle);
        if (!chuser) return false;
        
        if (!chuser.meta) {
            chuser.meta = {};
        }
        
        if (chuser.meta[key] !== value) {
            chuser.meta[key] = value;
            changed = true;
        }
        
        if (changed) {
            this._userdata.save();
            this.log(`Successfuly set ${key} = '${value}' in user ${handle}`);
        }
        return true;        
    }
    
    delMeta(handle, key) {
        if (!key) return false;
    
        let changed = false;
        let chuser = this.getUser(handle);
        if (!chuser) return false;
        
        if (!chuser.meta) return true;
        
        if (chuser.meta[key] !== undefined) {
            delete chuser.meta[key];
            changed = true;
        }
        
        if (changed) {
            this.log(`Successfuly deleted ${key} from user ${handle}`);
            this._userdata.save();
        }
        return true;
    }
    
    getMeta(handle, key) {
        let checkuser = this.getUser(handle);
        if (!key || !checkuser || !checkuser.meta) return undefined;
        return checkuser.meta[key];
    }
    
    listMetaKeys(handle) {
        let checkuser = this.getUser(handle);
        if (!checkuser || checkuser.meta) return [];
        return Object.keys(checkuser.meta);
    }
    

    //Programmatic permission providers (not persisted)
    //async callback(env, userid, channelid, permissions) -- Return a subset of permissions that the user has (empty for none).
    //  channelid is optional.

    registerPermissionProvider(func, self) {
        this.log('Registering permissions provider. Context: ' + self.constructor.name);
        if (!self) {
            this._permissionProviders.push(func);
        } else {
            this._permissionProviders.push([func, self]);
        }
    }


    async testPermissions(env, userid, channelid, permissions, requireall, handle) {  //env is an environment NAME; channelid is optional

        let removeduplicates = {};
        for (let perm of permissions) {
            removeduplicates[perm] = true;
        }

        let ascertained = {};

        //From providers

        for (let provider of this._permissionProviders) {
            let subset = [];
            if (typeof provider == "function") {
                subset = await provider.call(this, {env, userid, channelid, permissions});
            } else {
                subset = await provider[0].call(provider[1], {env, userid, channelid, permissions});
            }
            for (let perm of subset) {
                ascertained[perm] = true;
            }
        }

        //From account

        let handles = await this.getHandlesById(env, userid, true);
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


//This template can be extended by behaviors that contain a single permission provider
export class PermissionProvider extends Behavior {

    get description() { return "A permission provider for Users"; }

    get requiredBehaviors() { return {
        Users: 'Users'
    }; }

    constructor(typesuffix, name) {
        super('Permission' + typesuffix, name);
    }

    initialize(opt) {
        if (!super.initialize(opt)) return false;
        
        this.be('Users').registerPermissionProvider(async (args) => {
            args.env = opt.envProxy(args.env);
            return this.permissionProvider(args);
        }, this);

        return true;
    }

    //Override in implementation
    async permissionProvider(args) { return []; }

}
