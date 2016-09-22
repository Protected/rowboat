/* Module: FreeRoles -- Allows user to add or remove certain Discord roles to themselves. */

var Module = require('./Module.js');

class ModFreeRoles extends Module {

    get requiredParams() { return [
        'freeRoles'             //{ENVNAME: {ROLE: DESCRIPTION, ...}, ...}
    ]; }
    
    get optionalParams() { return [
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
        
        //Use a string to require a permission
        this._params['allowBecome'] = false;
        this._params['allowReject'] = true;
    }


    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;
        
        
        //Register callbacks
        
        this.mod("Commands").registerCommand('freeroles', {
            description: 'Show a list of roles that can be claimed by users.',
            environments: ['Discord']
        }, (env, type, userid, command, args, handle, reply) => {
        
            var roles = this.param('freeRoles');
            if (roles) roles = roles[env.name];
            
            for (let role in roles) {
                reply(role + ' - ' + roles[role]);
            }
        
            return true;
        });
        
        
        if (this.param('allowBecome')) {
            this.mod("Commands").registerCommand('become', {
                description: 'Request assignment of an allowed role to myself.',
                args: ['role'],
                environments: ['Discord'],
                permissions: (typeof this.param('allowBecome') == "string" ? [this.param('allowBecome')] : null)
            }, (env, type, userid, command, args, handle, reply) => {
            
                var roles = this.param('freeRoles');
                if (roles) roles = roles[env.name];
                if (!roles || !roles[args.role]) {
                    reply('Role not allowed. Please use the "freeroles" command for a list of allowed roles.');
                    return true;
                }
                
                var roleobj = env.server.roles.find('name', args.role);
                if (!roleobj) {
                    reply("The role \"" + args.role + "\" doesn't currently exist in this environment.");
                    return true;
                }
                
                var member = env.server.member(userid);
                if (member.roles.find('name', args.role)) {
                    reply('You already have the role "' + args.role + '".');
                    return true;
                }
                
                member.addRole(roleobj).then(() => {
                    reply("Role \"" + roleobj.name + "\" successfully assigned!");
                }).catch((err) => {
                    reply(err);
                });
            
                return true;
            });
        }
        
        
        if (this.param('allowReject')) {
            this.mod("Commands").registerCommand('reject', {
                description: 'Request unassignment of an allowed role from myself.',
                args: ['role'],
                environments: ['Discord'],
                permissions: (typeof this.param('allowReject') == "string" ? [this.param('allowReject')] : null)
            }, (env, type, userid, command, args, handle, reply) => {
            
                var roles = this.param('freeRoles');
                if (roles) roles = roles[env.name];
                if (!roles || !roles[args.role]) {
                    reply('Role not allowed. Please use the "freeroles" command for a list of allowed roles.');
                    return true;
                }
                
                var roleobj = env.server.roles.find('name', args.role);
                if (!roleobj) {
                    reply("The role \"" + args.role + "\" doesn't currently exist in this environment.");
                    return true;
                }
                
                var member = env.server.member(userid);
                if (!member.roles.find('name', args.role)) {
                    reply("You don't have the role \"" + args.role + "\".");
                    return true;
                }
                
                member.removeRole(roleobj).then(() => {
                    reply("Role \"" + roleobj.name + "\" successfully unassigned!");
                }).catch((err) => {
                    reply(err);
                });
            
                return true;
            });
        }
        
        
        return true;
    }
    
    
}


module.exports = ModFreeRoles;
