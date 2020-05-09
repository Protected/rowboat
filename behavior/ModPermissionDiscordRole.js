/* Module: PermissionDiscordRole -- This module is a permissions provider that turns Discord role names into ModUsers permissions. */

const Module = require('../Module.js');

class ModPermissionDiscordRole extends Module {

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Users'
    ]; }

    constructor(name) {
        super('PermissionDiscordRole', name);
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;
        
        
        //Register callbacks
        
        this.mod('Users').registerPermissionProvider((passedname, userid, channelid, permissions) => {
            let env = opt.envs[passedname];
            if (env.envName != 'Discord') return [];
        
            let member = env.server.members.cache.get(userid);
            if (!member) return [];
            
            let result = [];
        
            for (let permission of permissions) {
                let role = member.roles.cache.find(r => r.name == permission);
                if (role) result.push(permission);
            }
        
            return result;
        }, this);
        
        
        return true;
    }


}


module.exports = ModPermissionDiscordRole;
