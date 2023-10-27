import Behavior from "../src/Behavior.js";

export default class DiscordVoiceText extends Behavior {

    get description() { return "Adds voice channel users to a text channel only while they're connected"; }

    get params() { return [
        {n: "voicechannelid", d: "ID of the Discord voice channel to observe."},
        {n: "textchannelid", d: "ID of the Discord text channel to show to users who connect to the voice channel."}
    ]; }

    get requiredEnvironments() { return {
        Discord: 'Discord'
    }; }

    get isMultiInstanceable() { return true; }
    
    get denv() {
        return this.env('Discord');
    }

    constructor(name) {
        super('DiscordVoiceText', name);

    }

    initialize(opt) {
        if (!super.initialize(opt)) return false;

        let voiceStateUpdateHandler = (oldState, state) => {
            if (state.id == this.denv.server.members.me.id) return;

            let textchannel = this.denv.server.channels.cache.get(this.param("textchannelid"));
            if (!textchannel) return;

            if (oldState.channelId != this.param("voicechannelid") && state.channelId == this.param("voicechannelid")) {
                //User connected to the audio channel
                
                if (!textchannel.permissionOverwrites.cache.get(state.id)?.allow.has("ViewChannel")) {
                    textchannel.permissionOverwrites.edit(state.id, {ViewChannel: true}, "Connected to voice channel.");
                }

            }

            if (oldState.channelId == this.param("voicechannelid") && state.channelId != this.param("voicechannelid")) {
                //User left the audio channel

                if (textchannel.permissionOverwrites.cache.get(state.id)?.allow.has("ViewChannel")) {
                    textchannel.permissionOverwrites.edit(state.id, {ViewChannel: null}, "Disconnected from voice channel.");
                }

            }

        }

        this.denv.on("connected", async () => {

            let textchannel = this.denv.server.channels.cache.get(this.param("textchannelid"));
            let voicechannel = this.denv.server.channels.cache.get(this.param("voicechannelid"));

            if (voicechannel && textchannel) {

                for (let member of voicechannel.members.values()) {
                    if (!textchannel.members.get(member.id) && !textchannel.permissionOverwrites.cache.get(member.id)?.allow.has("ViewChannel")) {
                        textchannel.permissionOverwrites.edit(member.id, {ViewChannel: true}, "Connected to voice channel.");
                    }
                }

                for (let member of textchannel.members.values()) {
                    if (!voicechannel.members.get(member.id) && textchannel.permissionOverwrites.cache.get(member.id)?.allow.has("ViewChannel")) {
                        textchannel.permissionOverwrites.edit(member.id, {ViewChannel: null}, "Disconnected from voice channel.");
                    }
                }

            }

            this.denv.client.on("voiceStateUpdate", voiceStateUpdateHandler);
        });

      
        return true;
    };
    
    
    // # Module code below this line #
    

}
