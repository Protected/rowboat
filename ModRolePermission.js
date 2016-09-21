/* Module: RolePermission -- This module is a permissions provider that turns Discord roles into permissions. */

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
    
    
    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;
        
        
        //Register callbacks
        
        for (let name in envs) {
            var env = envs[name];
            this.mod('Users').registerPermissionProvider((passedname, userid, permissions) => {
                if (passedname != env.name) return [];
            
                var member = env.server().members.find('id', userid);
                if (!member) return [];
                
                var result = [];
            
                for (let permission in permissions) {
                    let role = member.roles.find('name', permission);
                    if (role) result.push(permission);
                }
            
                return result;
            }, this);
        }
        
        
        return true;
    }


}


module.exports = ModRolePermission;
