/* Module: FreeRoles -- Allows user to add or remove certain Discord roles to themselves. */

const Module = require('./Module.js');

const PERM_ADMIN = 'administrator';

class ModFreeRoles extends Module {

    get isMultiInstanceable() { return true; }
    
    get requiredParams() { return [
        'env'                   //Name of the Discord environment to be used
    ]; }

    get optionalParams() { return [
        'datafile',
        'enableCreation'        //Enable "role create"
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
        this._params['enableCreation'] = false;
        
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
            details: [
                "Use & to specify multiple roles to be assigned."
            ],
            args: ['role', true],
            environments: ['Discord']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let member = env.server.member(userid);

            let intersect = args.role.join(" ").split("&").map(el => el.trim());
            let roles = this._freeRoles[env.name];
            if (!roles) roles = {};

            if (intersect.length < 1) {
                ep.reply("Specify at least one role.");
                return true;
            }

            let rolestoadd = [];

            for (let role of intersect) {
                let lcrole = role.toLowerCase();
                if (!roles[lcrole]) {
                    ep.reply('Role "' + role + '" not allowed. Please use the "role" command for a list of allowed roles.');
                    return true;
                }

                role = roles[lcrole].name;

                let roleobj = env.server.roles.cache.find(r => r.name == role);
                if (!roleobj) {
                    ep.reply("The role \"" + role + "\" doesn't currently exist in this environment.");
                    continue;
                }

                if (member.roles.cache.find(r => r.name == role)) {
                    ep.reply('You already have the role "' + role + '".');
                    continue;
                }

                rolestoadd.push(roleobj);
            }

            if (rolestoadd.length < 1) {
                return true;
            }

            member.roles.add(rolestoadd, "Assignment requested by user.").then(() => {
                ep.reply("Role" + (rolestoadd.length != 1 ? "s" : "") + " \"" + rolestoadd.map(roleobj => roleobj.name).join("\", \"") + "\" successfully assigned!");
            }).catch((err) => {
                ep.reply(err);
            });
        
            return true;
        });
        
        
        this.mod("Commands").registerCommand(this, 'role reject', {
            description: 'Request unassignment of an allowed role from myself.',
            details: [
                "Use & to specify multiple roles to be rejected."
            ],
            args: ['role', true],
            environments: ['Discord']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let member = env.server.member(userid);

            let intersect = args.role.join(" ").split("&").map(el => el.trim());
            let roles = this._freeRoles[env.name];
            if (!roles) roles = {};

            if (intersect.length < 1) {
                ep.reply("Specify at least one role.");
                return true;
            }

            let rolestoremove = [];

            for (let role of intersect) {
                let lcrole = role.toLowerCase();
                if (!roles[lcrole]) {
                    ep.reply('Role "' + role + '" not allowed. Please use the "role" command for a list of allowed roles.');
                    return true;
                }

                role = roles[lcrole].name;

                let roleobj = env.server.roles.cache.find(r => r.name == role);
                if (!roleobj) {
                    ep.reply("The role \"" + role + "\" doesn't currently exist in this environment.");
                    continue;
                }

                if (!member.roles.cache.find(r => r.name == role)) {
                    ep.reply("You don't have the role \"" + role + "\".");
                    continue;
                }

                rolestoremove.push(roleobj);
            }

            if (rolestoremove.length < 1) {
                return true;
            }

            member.roles.remove(rolestoremove, "Removal requested by user.").then(() => {
                ep.reply("Role" + (rolestoremove.length != 1 ? "s" : "") + " \"" + rolestoremove.map(roleobj => roleobj.name).join("\", \"") + "\" successfully unassigned!");
            }).catch((err) => {
                ep.reply(err);
            });
        
            return true;
        });
        
        
        this.mod("Commands").registerCommand(this, 'members', {
            description: 'Lists the Discord users with the given role(s).',
            details: [
                "Use & to intersect multiple roles; Users must have every role to be listed."
            ],
            args: ['role', true],
            environments: ['Discord']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            
            let intersect = args.role.join(" ").split("&").map(el => el.trim());
            let roles = this._freeRoles[env.name];
            if (!roles) roles = {};

            if (intersect.length < 1) {
                ep.reply("Specify at least one role.");
                return true;
            }

            let resultids = null;

            for (let role of intersect) {
                let lcrole = role.toLowerCase();
                if (roles[lcrole]) {
                    role = roles[lcrole].name;
                }

                let roleobj = env.server.roles.cache.find(r => r.name == role);
                if (!roleobj) {
                    ep.reply("The role \"" + role + "\" doesn't currently exist in this environment.");
                    return true;
                }

                let members = roleobj.members.array().map(member => member.id);
                if (!resultids) {
                    resultids = members;
                } else {
                    resultids = resultids.filter(el => members.indexOf(el) > -1);
                }
            }

            let results = [];
            for (let id of resultids) {
                results.push(env.idToDisplayName(id));
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
            
            this.addRole(env, ep, args.role, args.description.join(" "));

            return true;
        });


        if (this.param('enableCreation')) {
            this.mod("Commands").registerCommand(this, 'role create', {
                description: 'Creates a Discord role and adds it to the list of free roles.',
                details: [
                    "Prefix the role name with a @ to create it with mentions enabled.",
                    "The color must be in hexadecimal RRGGBB format."
                ],
                args: ['role', 'color', 'description', true],
                environments: ['Discord'],
                permissions: [PERM_ADMIN]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
                
                let role = args.role.trim();
                let mentionable = false;

                if (role.substr(0, 1) == "@") {
                    role = role.substr(1);
                    mentionable = true;
                }

                if (!role) {
                    ep.reply('You must specify a role name.');
                    return true;
                }

                if (env.server.roles.cache.find(r => r.name == role)) {
                    ep.reply("The role \"" + role + "\" already exists in this environment.");
                    return true;
                }

                if (!args.color.match(/^[0-9a-f]{6}$/i)) {
                    ep.reply('The color must be in hexadecimal RGB format.');
                    return true;
                }

                env.server.createRole({
                    name: role,
                    color: args.color,
                    permissions: 0,
                    mentionable: mentionable
                }, "Creation requested by " + userid)
                    .then((roleobj) => {
                        this.addRole(env, ep, roleobj.name, args.description.join(" "));
                    })
                    .catch((e) => {
                        this.log('error', e);
                        ep.reply('Role "' + args.role + '" could not be created.');
                    });
    
                return true;
            });
        }
        
        
        this.mod("Commands").registerCommand(this, 'role del', {
            description: 'Removes an existing Discord role from the list of free roles.',
            args: ['role', true],
            environments: ['Discord'],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            
            let lcrole = args.role.join(" ").toLowerCase();
            
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


    addRole(env, ep, role, description) {
        let lcrole = role.toLowerCase();
            
        let roles = this._freeRoles[env.name];
        if (!roles) {
            roles = this._freeRoles[env.name] = {};
        }
        
        if (roles[lcrole]) {
            ep.reply('The role ' + role + ' is already in the list of free roles. If you want to change the description, please delist it first.');
            return false;
        }
        
        let roleobj = env.server.roles.cache.find(r => r.name == role);
        if (!roleobj) {
            ep.reply("The role \"" + role + "\" doesn't currently exist in this environment.");
            return false;
        }
        
        roles[lcrole] = {
            name: role,
            desc: description
        };
        
        this._freeRoles.save();
        
        ep.reply('Role "' + role + '" added successfully.');
        
        return true;
    }
    

}


module.exports = ModFreeRoles;
