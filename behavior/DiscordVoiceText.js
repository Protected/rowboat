/* Module: DiscordVoiceText -- Adds voice channel users to a text channel only while they're connected. */

const Module = require('../Module.js');

class ModDiscordVoiceText extends Module {

    get isMultiInstanceable() { return true; }

    get requiredParams() { return [
        "env",
        "voicechannelid",
        "textchannelid"
    ]; }

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
    ]; }
    
    get denv() {
        return this.env(this.param('env'));
    }

    constructor(name) {
        super('DiscordVoiceText', name);

    }

    initialize(opt) {
        if (!super.initialize(opt)) return false;

        let voiceStateUpdateHandler = (oldState, state) => {
            if (state.id == this.denv.server.me.id) return;

            let textchannel = this.denv.server.channels.cache.get(this.param("textchannelid"));
            if (!textchannel) return;

            if (oldState.channelId != this.param("voicechannelid") && state.channelId == this.param("voicechannelid")) {
                //User connected to the audio channel
                
                if (!textchannel.permissionOverwrites.cache.get(state.id)?.allow.has("VIEW_CHANNEL")) {
                    textchannel.permissionOverwrites.edit(state.id, {VIEW_CHANNEL: true}, "Connected to voice channel.");
                }

            }

            if (oldState.channelId == this.param("voicechannelid") && state.channelId != this.param("voicechannelid")) {
                //User left the audio channel

                if (textchannel.permissionOverwrites.cache.get(state.id)?.allow.has("VIEW_CHANNEL")) {
                    textchannel.permissionOverwrites.edit(state.id, {VIEW_CHANNEL: null}, "Disconnected from voice channel.");
                }

            }

        }

        this.denv.on("connected", async () => {

            let textchannel = this.denv.server.channels.cache.get(this.param("textchannelid"));
            let voicechannel = this.denv.server.channels.cache.get(this.param("voicechannelid"));

            if (voicechannel && textchannel) {

                for (let member of voicechannel.members.values()) {
                    if (!textchannel.members.get(member.id) && !textchannel.permissionOverwrites.cache.get(member.id)?.allow.has("VIEW_CHANNEL")) {
                        textchannel.permissionOverwrites.edit(member.id, {VIEW_CHANNEL: true}, "Connected to voice channel.");
                    }
                }

                for (let member of textchannel.members.values()) {
                    if (!voicechannel.members.get(member.id) && textchannel.permissionOverwrites.cache.get(member.id)?.allow.has("VIEW_CHANNEL")) {
                        textchannel.permissionOverwrites.edit(member.id, {VIEW_CHANNEL: null}, "Disconnected from voice channel.");
                    }
                }

            }

            this.denv.client.on("voiceStateUpdate", voiceStateUpdateHandler);
        });

      
        return true;
    };
    
    
    // # Module code below this line #
    



}


module.exports = ModDiscordVoiceText;

