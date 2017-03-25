/* Module: RolePermission -- This module is a permissions provider that turns Discord roles into ModUsers permissions. */

var Module = require('./Module.js');

class ModRolePermission extends Module {

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Users'
    ]; }

    constructor(name) {
        super('RolePermission', name);
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;
        
        
        //Register callbacks
        
        this.mod('Users').registerPermissionProvider((passedname, userid, permissions) => {
            var env = opt.envs[passedname];
            if (env.envName != 'Discord') return [];
        
            var member = env.server.members.get(userid);
            if (!member) return [];
            
            var result = [];
        
            for (let permission of permissions) {
                let role = member.roles.find('name', permission);
                if (role) result.push(permission);
            }
        
            return result;
        }, this);
        
        
        return true;
    }


}


module.exports = ModRolePermission;
