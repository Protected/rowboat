/* Module: PermissionDiscordUserID -- This module is a permissions provider that turns Discord user IDs into ModUsers permissions. */

const Module = require('../Module.js');

class ModPermissionDiscordUserID extends Module {

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Users'
    ]; }

    constructor(name) {
        super('PermissionDiscordUserID', name);
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;
        
        
        //Register callbacks
        
        this.mod('Users').registerPermissionProvider((passedname, userid, channelid, permissions) => {
            let env = opt.envs[passedname];
            if (env.envName != 'Discord') return [];
        
            let result = [];
        
            for (let permission of permissions) {
                if (permission == userid) result.push(permission);
            }
        
            return result;
        }, this);
        
        
        return true;
    }


}


module.exports = ModPermissionDiscordUserID;
