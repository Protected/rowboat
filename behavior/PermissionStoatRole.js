//WARNING: Any user allowed to rename their own roles or to create and assign themselves roles will be able to give themselves permissions.

import { PermissionProvider } from "./Users.js";

export default class PermissionStoatRole extends PermissionProvider {

    get description() { return "Permissions provider that turns Stoat role names into permissions"; }

    constructor(name) {
        super('StoatRole', name);
    }
    
    async permissionProvider({env, userid, permissions}) {
        if (env.type != "Stoat") return [];

        let member = env.server.getMember(userid);
        if (!member) return [];

        let result = [];
    
        for (let permission of permissions) {
            if (member.orderedRoles.find(role => role.name === permission)) {
                result.push(permission);
            }
        }
    
        return result;
    }

}
