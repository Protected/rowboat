/* PermissionDiscordRoleID -- Permissions provider that turns Discord role IDs into permissions. */

import { PermissionProvider } from "./Users.js";

export default class PermissionDiscordRoleID extends PermissionProvider {

    constructor(name) {
        super('DiscordRoleID', name);
    }
    
    async permissionProvider({env, userid, permissions}) {
        if (env.type != "Discord") return [];

        let member = env.server.members.cache.get(userid);
        if (!member) return [];
        
        let result = [];
    
        for (let permission of permissions) {
            let role = member.roles.cache.get(permission);
            if (role) result.push(permission);
        }
    
        return result;
    }

}
