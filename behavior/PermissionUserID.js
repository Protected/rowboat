/* PermissionUserID -- Permissions provider that turns user IDs into permissions. */

import { PermissionProvider } from "./Users.js";

export default class PermissionUserID extends PermissionProvider {

    constructor(name) {
        super('UserID', name);
    }
    
    async permissionProvider({userid, permissions}) {
        let result = [];
    
        for (let permission of permissions) {
            if (permission == userid) result.push(permission);
        }
    
        return result;
    }

}
