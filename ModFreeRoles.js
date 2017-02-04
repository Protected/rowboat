/* Module: FreeRoles -- Allows user to add or remove certain Discord roles to themselves. */

var Module = require('./Module.js');
var fs = require('fs');
var jsonfile = require('jsonfile');

var PERM_ADMIN = 'administrator';

class ModFreeRoles extends Module {

    get optionalParams() { return [
        'datafile',
        'allowBecome',          //Enable/permission for !become
        'allowReject'           //Enable/permission for !reject
    ]; }
    
    get requiredEnvironments() { return [
        'Discord'
    ]; }
    
    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('FreeRoles', name);
        
        this._params['datafile'] = 'freeroles.data.json';
        
        //Use a string to require a permission
        this._params['allowBecome'] = false;
        this._params['allowReject'] = true;
        
        //{ENVNAME: {LCROLE: {name: ROLE, desc: DESCRIPTION}, ...}, ...}
        this._freeRoles = {};
    }


    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;
        
        //Load data
        
        if (!this.loadData()) return false;
        
        
        //Register callbacks
        
        for (var envname in envs) {
            let env = envs[envname];
            if (env.envName != 'Discord') continue;
            
            env.client.on('roleUpdate', (oldRole, newRole) => {
                let lcrole = oldRole.name.toLowerCase();
                let lcrolenew = newRole.name.toLowerCase();
                if (lcrole == lcrolenew) return;
                
                if (this._freeRoles[env.name][lcrole]) {
                    this._freeRoles[env.name][lcrolenew] = this._freeRoles[env.name][lcrole];
                    delete this._freeRoles[env.name][lcrole];
                    this._freeRoles[env.name][lcrolenew].name = newRole.name;
                    this.saveData();
                }
            });
            
            env.client.on('roleDelete', (role) => {
                let lcrole = role.name.toLowerCase();
                if (this._freeRoles[env.name][lcrole]) {
                    delete this._freeRoles[env.name][lcrole];
                    this.saveData();
                }
            });
        }
        
        
        this.mod("Commands").registerCommand(this, 'roles', {
            description: 'Show a list of free roles (that can be claimed by users).',
            environments: ['Discord']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            var roles = this._freeRoles[env.name];
            if (!roles) return true;
            
            if (Object.keys(roles).length) {
                for (let role in roles) {
                    ep.reply('**' + roles[role].name + '** - ' + roles[role].desc);
                }
            } else {
                ep.reply('No free roles configured.');
            }
        
            return true;
        });
        
        
        if (this.param('allowBecome')) {
            this.mod("Commands").registerCommand(this, 'become', {
                description: 'Request assignment of an allowed role to myself.',
                args: ['role'],
                environments: ['Discord'],
                permissions: (typeof this.param('allowBecome') == "string" ? [this.param('allowBecome')] : null)
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                var lcrole = args.role.toLowerCase();
            
                var roles = this._freeRoles[env.name];
                if (!roles || !roles[lcrole]) {
                    ep.reply('Role not allowed. Please use the "roles" command for a list of allowed roles.');
                    return true;
                }
                
                var roleobj = env.server.roles.find('name', roles[lcrole].name);
                if (!roleobj) {
                    ep.reply("The role \"" + roles[lcrole].name + "\" doesn't currently exist in this environment.");
                    return true;
                }
                
                var member = env.server.member(userid);
                if (member.roles.find('name', roles[lcrole].name)) {
                    ep.reply('You already have the role "' + roles[lcrole].name + '".');
                    return true;
                }
                
                member.addRole(roleobj).then(() => {
                    ep.reply("Role \"" + roleobj.name + "\" successfully assigned!");
                }).catch((err) => {
                    ep.reply(err);
                });
            
                return true;
            });
        }
        
        
        if (this.param('allowReject')) {
            this.mod("Commands").registerCommand(this, 'reject', {
                description: 'Request unassignment of an allowed role from myself.',
                args: ['role'],
                environments: ['Discord'],
                permissions: (typeof this.param('allowReject') == "string" ? [this.param('allowReject')] : null)
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                var lcrole = args.role.toLowerCase();
            
                var roles = this._freeRoles[env.name];
                if (!roles || !roles[lcrole]) {
                    ep.reply('Role not allowed. Please use the "roles" command for a list of allowed roles.');
                    return true;
                }
                
                var roleobj = env.server.roles.find('name', roles[lcrole].name);
                if (!roleobj) {
                    ep.reply("The role \"" + roles[lcrole].name + "\" doesn't currently exist in this environment.");
                    return true;
                }
                
                var member = env.server.member(userid);
                if (!member.roles.find('name', roles[lcrole].name)) {
                    ep.reply("You don't have the role \"" + roles[lcrole].name + "\".");
                    return true;
                }
                
                member.removeRole(roleobj).then(() => {
                    ep.reply("Role \"" + roleobj.name + "\" successfully unassigned!");
                }).catch((err) => {
                    ep.reply(err);
                });
            
                return true;
            });
        }
        
        
        this.mod("Commands").registerCommand(this, 'members', {
            description: 'Lists the Discord users with the given free role.',
            args: ['role'],
            environments: ['Discord']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            
            var lcrole = args.role.toLowerCase();
            var role = args.role;
            
            var roles = this._freeRoles[env.name];
            if (roles && roles[lcrole]) {
                role = roles[lcrole].name;
            }
            
            var roleobj = env.server.roles.find('name', role);
            if (!roleobj) {
                ep.reply("The role \"" + role + "\" doesn't currently exist in this environment.");
                return true;
            }
            
            var results = [];
            for (let member of roleobj.members.array()) {
                results.push(env.idToDisplayName(member.id));
            }
            
            if (results.length) {
                while (results.length) {
                    var outbound = results.slice(0, 10).join(', ');
                    ep.reply(outbound);
                    results = results.slice(10);
                }
            } else {
                ep.reply("No members found.");
            }
            
            return true;
        });
        
        
        this.mod("Commands").registerCommand(this, 'roleadd', {
            description: 'Adds an existing Discord role to the list of free roles.',
            args: ['role', 'description', true],
            environments: ['Discord'],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            
            var lcrole = args.role.toLowerCase();
            
            var roles = this._freeRoles[env.name];
            if (!roles) {
                roles = this._freeRoles[env.name] = {};
            }
            
            if (roles[lcrole]) {
                ep.reply('The role ' + args.role + ' is already in the list of free roles. If you want to change the description, please delist it first.');
                return true;
            }
            
            var roleobj = env.server.roles.find('name', args.role);
            if (!roleobj) {
                ep.reply("The role \"" + args.role + "\" doesn't currently exist in this environment.");
                return true;
            }
            
            roles[lcrole] = {
                name: args.role,
                desc: args.description.join(" ")
            };
            
            this.saveData();
            
            ep.reply('Role "' + args.role + '" added successfully.');
            
            return true;
        });
        
        
        this.mod("Commands").registerCommand(this, 'roledel', {
            description: 'Removes an existing Discord role from the list of free roles.',
            args: ['role'],
            environments: ['Discord'],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            
            var lcrole = args.role.toLowerCase();
            
            var roles = this._freeRoles[env.name];
            if (!roles || !roles[lcrole]) {
                ep.reply('The role ' + args.role + ' is not in the list of free roles.');
                return true;
            }
            
            delete roles[lcrole];
            
            this.saveData();
            
            ep.reply('Role "' + args.role + '" removed successfully.');
            
            return true;
        });
        
        
        return true;
    }
    
    
    // # Module code below this line #


    //Data file manipulation

    loadData() {
        var datafile = this.param('datafile');
     
        try {
            fs.accessSync(datafile, fs.F_OK);
        } catch (e) {
            jsonfile.writeFileSync(datafile, {});
        }

        try {
            this._freeRoles = jsonfile.readFileSync(datafile);
        } catch (e) {
            return false;
        }
        if (!this._freeRoles) this._freeRoles = {};
        
        return true;
    }

    saveData() {
        var datafile = this.param('datafile');
        
        jsonfile.writeFileSync(datafile, this._freeRoles);
    }
    
    
}


module.exports = ModFreeRoles;
