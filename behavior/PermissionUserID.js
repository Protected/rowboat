import { PermissionProvider } from "./Users.js";

export default class PermissionUserID extends PermissionProvider {

    get description() { return "Permissions provider that turns user IDs into permissions"; }

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
