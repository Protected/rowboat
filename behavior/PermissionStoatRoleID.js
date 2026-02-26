import { PermissionProvider } from "./Users.js";

export default class PermissionStoatRoleID extends PermissionProvider {

    get description() { return "Permissions provider that turns Stoat role IDs into permissions"; }

    constructor(name) {
        super('StoatRoleID', name);
    }
    
    async permissionProvider({env, userid, permissions}) {
        if (env.type != "Stoat") return [];

        let member = env.server.getMember(userid);
        if (!member) return [];
        
        let result = [];
    
        for (let permission of permissions) {
            if (member.roles.find(roleid => roleid === permission)) {
                result.push(permission);
            } 
        }
    
        return result;
    }

}
