/* PermissionGenericRole -- Permissions provider that turns generic environment roles into permissions. */

import { PermissionProvider } from "./Users.js";

export default class PermissionGenericRole extends PermissionProvider {

    constructor(name) {
        super('GenericRole', name);
    }
    
    async permissionProvider({env, userid, channelid, permissions}) {
        let roles = await env.listUserRoles(userid, channelid);
    
        let result = [];
    
        for (let permission of permissions) {
            if (roles.indexOf(permission) > -1) {
                result.push(permission);
            }
        }
    
        return result;
    }

}
