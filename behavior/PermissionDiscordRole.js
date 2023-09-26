/* PermissionDiscordRole -- Permissions provider that turns Discord role names into permissions. */

//WARNING: Any user allowed to rename their own roles or to create and assign themselves roles will be able to give themselves permissions.

import { PermissionProvider } from "./Users.js";

export default class PermissionDiscordRole extends PermissionProvider {

    constructor(name) {
        super('DiscordRole', name);
    }
    
    async permissionProvider({env, userid, permissions}) {
        if (env.type != "Discord") return [];

        let member = env.server.members.cache.get(userid);
        if (!member) return [];

        let result = [];
    
        for (let permission of permissions) {
            let role = member.roles.cache.find(r => r.name == permission);
            if (role) result.push(permission);
        }
    
        return result;
    }

}
