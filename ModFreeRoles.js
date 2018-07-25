/* Module: FreeRoles -- Allows user to add or remove certain Discord roles to themselves. */

const Module = require('./Module.js');

const PERM_ADMIN = 'administrator';

class ModFreeRoles extends Module {

    get isMultiInstanceable() { return true; }
    
    get requiredParams() { return [
        'env'                   //Name of the Discord environment to be used
    ]; }

    get optionalParams() { return [
        'datafile'
    ]; }
    
    get requiredEnvironments() { return [
        'Discord'
    ]; }
    
    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('FreeRoles', name);
        
        this._params['datafile'] = null;
        
        //{ENVNAME: {LCROLE: {name: ROLE, desc: DESCRIPTION}, ...}, ...}
        this._freeRoles = {};
    }


    initialize(opt) {
        if (!super.initialize(opt)) return false;
        
        //Load data
        
        this._freeRoles = this.loadData();
        if (this._freeRoles === false) return false;
        
        
        //Register callbacks
        
        if (!opt.envs[this.param('env')] || opt.envs[this.param('env')].envName != 'Discord') {
            this.log('error', "Environment not found.");
            return false;
        }
        
        let env = opt.envs[this.param('env')];
        env.on('connected', (env) => {
            env.client.on('roleUpdate', (oldRole, newRole) => {
                if (oldRole.guild.id != env.server.id) return;
                let lcrole = oldRole.name.toLowerCase();
                let lcrolenew = newRole.name.toLowerCase();
                if (lcrole == lcrolenew) return;
                
                if (this._freeRoles[env.name] && this._freeRoles[env.name][lcrole]) {
                    this._freeRoles[env.name][lcrolenew] = this._freeRoles[env.name][lcrole];
                    delete this._freeRoles[env.name][lcrole];
                    this._freeRoles[env.name][lcrolenew].name = newRole.name;
                    this._freeRoles.save();
                }
            });
            
            env.client.on('roleDelete', (role) => {
                if (role.guild.id != env.server.id) return;
                let lcrole = role.name.toLowerCase();
                if (this._freeRoles[env.name] && this._freeRoles[env.name][lcrole]) {
                    delete this._freeRoles[env.name][lcrole];
                    this._freeRoles.save();
                }
            });
        });
        
        
        this.mod("Commands").registerCommand(this, 'role', {
            description: 'Show a list of free roles (that can be claimed by users).',
            environments: ['Discord']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let roles = this._freeRoles[env.name];
            if (!roles) return true;
            
            if (Object.keys(roles).length) {
                for (let role of Object.keys(roles).sort()) {
                    ep.reply('**' + roles[role].name + '** - ' + roles[role].desc);
                }
            } else {
                ep.reply('No free roles configured.');
            }
        
            return true;
        });
        
        
        this.mod("Commands").registerCommand(this, 'role become', {
            description: 'Request assignment of an allowed role to myself.',
            args: ['role'],
            environments: ['Discord']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let lcrole = args.role.toLowerCase();
        
            let roles = this._freeRoles[env.name];
            if (!roles || !roles[lcrole]) {
                ep.reply('Role not allowed. Please use the "roles" command for a list of allowed roles.');
                return true;
            }
            
            let roleobj = env.server.roles.find('name', roles[lcrole].name);
            if (!roleobj) {
                ep.reply("The role \"" + roles[lcrole].name + "\" doesn't currently exist in this environment.");
                return true;
            }
            
            let member = env.server.member(userid);
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
        
        
        this.mod("Commands").registerCommand(this, 'role reject', {
            description: 'Request unassignment of an allowed role from myself.',
            args: ['role'],
            environments: ['Discord']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let lcrole = args.role.toLowerCase();
        
            let roles = this._freeRoles[env.name];
            if (!roles || !roles[lcrole]) {
                ep.reply('Role not allowed. Please use the "roles" command for a list of allowed roles.');
                return true;
            }
            
            let roleobj = env.server.roles.find('name', roles[lcrole].name);
            if (!roleobj) {
                ep.reply("The role \"" + roles[lcrole].name + "\" doesn't currently exist in this environment.");
                return true;
            }
            
            let member = env.server.member(userid);
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
        
        
        this.mod("Commands").registerCommand(this, 'members', {
            description: 'Lists the Discord users with the given free role.',
            args: ['role'],
            environments: ['Discord']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            
            let lcrole = args.role.toLowerCase();
            let role = args.role;
            
            let roles = this._freeRoles[env.name];
            if (roles && roles[lcrole]) {
                role = roles[lcrole].name;
            }
            
            let roleobj = env.server.roles.find('name', role);
            if (!roleobj) {
                ep.reply("The role \"" + role + "\" doesn't currently exist in this environment.");
                return true;
            }
            
            let results = [];
            for (let member of roleobj.members.array()) {
                results.push(env.idToDisplayName(member.id));
            }
            
            if (results.length) {
                while (results.length) {
                    let outbound = results.slice(0, 10).join(', ');
                    ep.reply(outbound);
                    results = results.slice(10);
                }
            } else {
                ep.reply("No members found.");
            }
            
            return true;
        });
        
        
        this.mod("Commands").registerCommand(this, 'role add', {
            description: 'Adds an existing Discord role to the list of free roles.',
            args: ['role', 'description', true],
            environments: ['Discord'],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            
            let lcrole = args.role.toLowerCase();
            
            let roles = this._freeRoles[env.name];
            if (!roles) {
                roles = this._freeRoles[env.name] = {};
            }
            
            if (roles[lcrole]) {
                ep.reply('The role ' + args.role + ' is already in the list of free roles. If you want to change the description, please delist it first.');
                return true;
            }
            
            let roleobj = env.server.roles.find('name', args.role);
            if (!roleobj) {
                ep.reply("The role \"" + args.role + "\" doesn't currently exist in this environment.");
                return true;
            }
            
            roles[lcrole] = {
                name: args.role,
                desc: args.description.join(" ")
            };
            
            this._freeRoles.save();
            
            ep.reply('Role "' + args.role + '" added successfully.');
            
            return true;
        });
        
        
        this.mod("Commands").registerCommand(this, 'role del', {
            description: 'Removes an existing Discord role from the list of free roles.',
            args: ['role'],
            environments: ['Discord'],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            
            let lcrole = args.role.toLowerCase();
            
            let roles = this._freeRoles[env.name];
            if (!roles || !roles[lcrole]) {
                ep.reply('The role ' + args.role + ' is not in the list of free roles.');
                return true;
            }
            
            delete roles[lcrole];
            
            this._freeRoles.save();
            
            ep.reply('Role "' + args.role + '" removed successfully.');
            
            return true;
        });
        
        
        return true;
    }
    
    
    // # Module code below this line #

    
    
}


module.exports = ModFreeRoles;
