import Environment from '../src/Environment.js';

export default class EnvMatrix extends Environment {

    get description() { return "Connects to a Matrix homeserver."; }

    get params() { return [

    ]; }
    
    get defaults() { return {

    }; }
    
    constructor(name) {
        super('Matrix', name);

    }


    connect() {}
    disconnect() {}
    msg(targetid, msg, options) {}
    notice(targetid, msg, options) {}

    idToDisplayName(id) { return null; }
    async displayNameToId(displayName) { return null; }
    
    idToMention(id) { return null; }                                    //Convert a user ID into a format most likely to trigger an alert
    
    idIsSecured(id) { return false; }
    idIsAuthenticated(id) { return false; }
    
    listUserIds(channel) { return []; }                                 //List IDs of users in a channel
    
    listUserRoles(id, channel) { return []; }                           //List a specific user's global roles and, if a channel is specified, roles specific to that channel
    
    
    channelIdToDisplayName(channelid) { return null; }
    channelIdToType(channelid) { return "regular"; }                    //Obtain a channel's type (compatible with events)
    
    roleIdToDisplayName(roleid) { return null; }
    displayNameToRoleId(displayName) { return null; }
    
    
    normalizeFormatting(text) { return text; }                          //Convert formatting to a cross-environment normalized format
    applyFormatting(text) { return text; }                              //Convert normalized formatting to environment-specific formatting

}
