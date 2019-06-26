/* Module: PermissionGenericRole -- This module is a permissions provider that turns roles from any environment into ModUsers permissions. */

const Module = require('./Module.js');

class ModPermissionGenericRole extends Module {

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Users'
    ]; }

    constructor(name) {
        super('PermissionGenericRole', name);
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;
        
        
        //Register callbacks
        
        this.mod('Users').registerPermissionProvider((passedname, userid, channelid, permissions) => {
            let env = opt.envs[passedname];
        
            let roles = env.listUserRoles(userid, channelid);
        
            let result = [];
        
            for (let permission of permissions) {
                if (roles.indexOf(permission) > -1) {
                    result.push(permission);
                }
            }
        
            return result;
        }, this);
        
        
        return true;
    }


}


module.exports = ModPermissionGenericRole;
