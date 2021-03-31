/* Module: VRChatPhotos -- Manages a channel for sharing VRChat photos and screenshots. */

const random = require('meteor-random');
const { MessageEmbed, Message } = require('discord.js');
const pngextract = require('png-chunks-extract');

const Module = require('../Module.js');

const PERM_ADMIN = 'administrator';

const MAX_FIELDLEN = 1024;

class ModVRChatPhotos extends Module {

    get isMultiInstanceable() { return true; }

    get requiredParams() { return [
        "env",
        "photochan",            //ID of text channel for photos
    ]; }
    
    get optionalParams() { return [
        "name",                 //Album name override
        "deleteemoji",          //Emoji for deleting things
    ]; }

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands',
        'VRChat'
    ]; }

    get denv() {
        return this.env(this.param('env'));
    }

    get photochan() {
        return this.denv.server.channels.cache.get(this.param("photochan"));
    }

    constructor(name) {
        super('VRChatPhotos', name);
     
        this._params["name"] = name.toLowerCase();
        this._params["deleteemoji"] = "❌";

        this._index = {};  //{ID: MESSAGE, ...}
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        
        //# Register Discord callbacks

        let messageReactionAddHandler = async (messageReaction, user) => {
            if (user.id == this.denv.server.me.id) return;

            //Delete photos
            if (this.photochan && messageReaction.message.channel.id == this.photochan.id) {

                if (messageReaction.emoji.name == this.param("deleteemoji")) {
                    let owners = this.extractOwnersFromPicture(messageReaction.message);
                    if (owners && owners.find(owner => owner == user.id)) {
                        messageReaction.message.delete({reason: "Photo removal requested by owner."});
                    } else {
                        messageReaction.users.remove(user.id);
                    }
                }

            }

        };


        let messageHandler = (env, type, message, authorid, channelid, messageObject) => {
            if (env.name != this.param("env") || type != "regular") return;
            if (channelid != this.photochan?.id) return;
                
            //Sharing to photochan

            if (this.messageHasAttachmentPhotos(messageObject)) {
                this.reemitMessage(messageObject);
            }

            return true;
        };


        let messageUpdateHandler = (oldMessage, message) => {
            if (!this.messageHasPhotos(oldMessage) && this.messageHasPhotos(message)) {
                this._index[message.id] = message;
            }
            if (this.messageHasPhotos(oldMessage) && !this.messageHasPhotos(message)) {
                delete this._index[message.id];
            }
        };

        let messageDeleteHandler = (message) => {
            if (this._index[message.id]) {
                delete this._index[message.id];
            }
        };

        
        this.denv.on("connected", async () => {

            //Prefetch and index channel contents

            this._index = {};
            
            this.denv.scanEveryMessage(this.photochan, (message) => {
                if (this.messageHasPhotos(message)) {
                    this._index[message.id] = message;
                }
            });

            this.denv.client.on("messageReactionAdd", messageReactionAddHandler);
            this.denv.on("message", messageHandler);
            this.denv.client.on("messageUpdate", messageUpdateHandler);
            this.denv.client.on("messageDelete", messageDeleteHandler);
        });


        //# Register commands

        this.mod('Commands').registerRootExtension(this, 'VRChat', 'vrcfix');

        this.mod('Commands').registerCommand(this, 'vrcfix process' + this.param("name"), {
            description: "Process an unprocessed photo message as if it had just been sent.",
            args: ["messageid"],
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let message = await this.photochan.messages.fetch(args.messageid);
            if (!message) {
                ep.reply("Message not found.");
                return true;
            }

            await this.reemitMessage(message);
            ep.reply("Ok.");

            return true;
        });


        this.mod('Commands').registerRootExtension(this, 'VRChat', 'vrcany');

        this.mod('Commands').registerCommand(this, 'vrcany ' + this.param("name"), {
            description: "Obtain a random photo from the " + this.param("name") + " album.",
            details: [
                "The filter is applied against the full usernames of the participants in the photo (if known)."
            ],
            args: ["filter", true],
            minArgs: 0
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this.photochan) return true;

            let filter = undefined;
            if (args.filter.length) {
                filter = messages => messageid => {
                    let data = this.getPhotoMessageFields(messages[messageid]);
                    return this.matchAgainstFilters(data, args.filter.join(" "), [
                        (data, filter) => data.sharedBy.toLowerCase() == filter,
                        (data, filter) => data.author?.toLowerCase() == filter,
                        (data, filter) => data.with && data.with.find(participant => participant.toLowerCase() == filter)
                    ]);
                };
            }

            let message = this.randomPhoto(filter);
            if (!message) {
                ep.reply("There are no photos" + (args.filter.length ? " matching your search" : "") + "!");
                return true;
            }

            let data = this.getPhotoMessageFields(message);
            if (!data) return true;

            let channel;
            if (userid == channelid) {
                channel = await env.client.realClient.users.fetch(userid).then(user => user.createDM());
            } else {
                channel = env.server.channels.cache.get(channelid);
            }

            let pickembed = new MessageEmbed();
            pickembed.setImage(data.image);

            channel.send(this.getPhotoMsgURL(message.id), pickembed);

            return true;
        });

        
        return true;
    };



    // # Module code below this line #


    //Handling of messages with pictures

    messageHasAttachmentPhotos(message) {
        if (!message) return false;
        for (let attachment of message.attachments.array()) {
            if (attachment.width) return true;
        }
        return false;
    }

    messageHasPhotos(message) {
        if (!message) return false;
        for (let embed of message.embeds) {
            if (embed.type == "rich" && embed.image) return true;
        }
        for (let attachment of message.attachments.array()) {
            if (attachment.width) return true;
        }
        return false;
    }

    getMessageAttachmentPhoto(message, onPhoto) {
        if (!message || !onPhoto) return null;

        for (let attachment of message.attachments.array()) {
            if (!attachment.width) continue;

            return this.urlget(attachment.url, {buffer: true})
                .then((data) => onPhoto(attachment, data))
                .catch((e) => { })
                ;
        }

        return null;
    }

    getPhotoMessageFields(message) {
        if (!message) return {};

        for (let embed of message.embeds) {
            if (embed.type == "rich" && embed.image) {

                let data = this.extractParticipantNamesFromPicture(message);

                return {
                    type: "extracted",
                    sharedBy: data.sharedBy || "",
                    image: embed.image.url,
                    width: embed.image.width,
                    height: embed.image.height,
                    author: data.author || "",
                    with: data.with || []
                }
            }
        }

        for (let attachment of message.attachments.array()) {
            if (attachment.width) {
                return {
                    type: "attachment",
                    sharedBy: message.member?.displayName || message.author?.username,
                    image: attachment.url,
                    width: attachment.width,
                    height: attachment.height
                }
            }
        }

        return {type: "notfound"}
    }


    reemitMessage(message) {
        if (!message || !this.messageHasAttachmentPhotos(message)) return null;

        return this.getMessageAttachmentPhoto(message, (attachment, data) => {

            let metadata = null;
            if (attachment.name && attachment.name.match(/\.png$/i)) {
                metadata = pngextract(data)
                    .filter(chunk => chunk.name == "tEXt" || chunk.name == "iTXt")
                    .map(chunk => chunk.name == "tEXt" ? this.pngDecodetEXt(chunk.data) : this.pngDecodeiTXt(chunk.data))
                    .find(text => text.keyword == "Description" && text.text.match(/^lfs|2|/));
                if (metadata) {
                    metadata = this.lfsMetadataToObject(metadata.text);
                }
            }

            return message.delete({reason: "Replacing with embed."})
                .then(() => this.bakePicture(attachment.name || "photo.png", data, message.author.id, metadata))
                .then((message) => { this._index[message.id] = message; })
                .catch((e) => { });
        });
    }

    
    //Picture metadata

    async bakePicture(name, data, userid, metadata) {
        if (!name || !data || !data.length || !userid) return null;

        let vrchat = this.mod("VRChat");

        let sharedBy = this.denv.idToDisplayName(userid);

        let emb = new MessageEmbed();

        if (metadata) {
            let sbperson = vrchat.getPerson(userid);
            if (sbperson && metadata.author.id == sbperson.vrc) {
                sharedBy = null;
            }

            let people = metadata.players
                .sort((a, b) => {
                    if (a.z > 0 && b.z < 0) return -1;
                    if (a.z < 0 && b.z > 0) return 1;
                    return a.x - b.x || a.y - b.y || a.z - b.z;
                })
                .map(player => {
                    let result = player.name;
                    if (player.id == metadata.author.id) result = "__" + result + "__";
                    if (player.z < 0) result = "*" + result + "*";
                    let playeruserid = vrchat.getUseridByVrc(player.id);
                    if (playeruserid) result = "[" + result + "](" + vrchat.getPersonMsgURL(playeruserid) + ")";
                    return result;
                });
                

            if (people.length) {
                //Pack subjects into embed fields whose contents are safely <MAX_FIELDLEN long
                let fieldcount = 0;
                let val = people.shift();
                while (people) {
                    let person = people.shift();
                    if (!person) break;
                    let newval = val + ", " + person;
                    if (newval.length < MAX_FIELDLEN) {
                        val = newval;
                        continue;
                    }
                    emb.addField(fieldcount ? "\u200b" : "With", val);
                    fieldcount += 1;
                    val = person;
                }
                if (val) emb.addField(fieldcount ? "\u200b" : "With", val);
            }

            emb.addField("Location", "[" + metadata.world.name + "](https://vrchat.com/home/world/" + metadata.world.id + ")", true);
        }

        if (sharedBy) {
            let msgurl = vrchat.getPersonMsgURL(userid);
            if (msgurl) sharedBy = "[" + sharedBy + "](" + msgurl + ")";
            emb.addField("Shared by", sharedBy, true);
        }

        emb.attachFiles({name: name, attachment: data})
            .setImage("attachment://" + encodeURI(name));

        try {
            return this.photochan.send({embed: emb, disableMentions: 'all'});
        } catch (e) {
            this.log("error", "Failed to bake picture " + url + ": " + JSON.stringify(e));
        }
    }


    extractOwnersFromPicture(message) {
        if (!message) return null;

        let vrchat = this.mod("VRChat");

        let emb = null;
        for (let checkembed of message.embeds) {
            if (checkembed.type == "rich") {
                emb = checkembed;
                break;
            }
        }
        if (!emb || !emb.image) return null;

        let results = [];
        for (let field of emb.fields) {
            if (field.name.match(/^shared by$/i)) {
                let extrs = field.value.match(/\[[^\]]+\]\(https:\/\/discord\.com\/channels\/[0-9]+\/[0-9]+\/([0-9]+)\)/);
                if (extrs) {
                    let person = vrchat.findPersonByMsg(extrs[1]);
                    if (person) results.push(person);
                }
            }
            if (field.name.match(/^with$/i)) {
                let extrs = field.value.match(/\[[^\]]*__[^\]]+__[^\]]*\]\(https:\/\/discord\.com\/channels\/[0-9]+\/[0-9]+\/([0-9]+)\)/);
                if (extrs) {
                    let person = vrchat.findPersonByMsg(extrs[1]);
                    if (person) results.push(person);
                }
            }
        }

        return results;
    }

    extractParticipantNamesFromPicture(message) {
        if (!message) return null;

        let emb = null;
        for (let checkembed of message.embeds) {
            if (checkembed.type == "rich") {
                emb = checkembed;
                break;
            }
        }
        if (!emb || !emb.image) return null;

        let results = {};
        for (let field of emb.fields) {
            if (field.name.match(/^shared by$/i)) {
                let extrs = field.value.match(/^\[([^\]]+)\]/);
                if (extrs) results.sharedBy = extrs[1];
                else results.sharedBy = field.value;
            }
            if (field.name.match(/^with$/i)) {
                let participants = [];
                for (let person of field.value.split(",")) {
                    person = person.trim();
                    let extr = person.match(/^\[([^\]]+)\]/);
                    if (extr) person = extr[1];
                    extr = person.match(/^\*(.+)\*$/);
                    if (extr) person = extr[1];
                    extr = person.match(/^\_\_(.+)\_\_$/);
                    if (extr) {
                        person = extr[1];
                        results.author = person;
                    }
                    participants.push(person);
                }
                results.with = participants;
            }
        }

        return results;
    }


    getPhotoMsgURL(msgid) {
        if (!msgid || !this.photochan) return "";
        return "https://discord.com/channels/" + this.denv.server.id + "/" + this.photochan.id + "/" + msgid;
    }

    randomPhoto(makefilter) {
        return this.randomEntry(this._index, makefilter ? makefilter(this._index) : undefined);
    }

    
    //Helpers

    testEnv(env) {
        return env.name == this.denv.name;
    }

    randomEntry(map, filter) {
        let keys = Object.keys(map);
        if (filter) keys = keys.filter(filter);
        if (!keys.length) return null;
        let key = keys[Math.floor(random.fraction() * keys.length)];
        return Object.assign({key: key}, map[key]);
    }

    embedFieldByName(emb, name) {
        if (!emb || !name) return null;
        for (let field of emb.fields) {
            if (field.name.toLowerCase() == name.toLowerCase()) {
                return field;
            }
        }
        return null;
    }

    matchAgainstFilters(thing, filterstr, tests) {
        //tests = [(thing, filter) => true|false, ...]
        if (!thing || !filterstr || !tests || !tests.length) return false;
        let orfilters = filterstr.toLowerCase().split("|").map(filter => filter.trim());
        for (let orfilter of orfilters) {
            let ofresult = true;
            let andfilters = orfilter.split("&").map(filter => filter.trim());
            for (let andfilter of andfilters) {
                let afresult = false;
                for (let test of tests) {
                    if (test(thing, andfilter)) { afresult = true; break; }  //one valid test validates filter
                }
                if (!afresult) { ofresult = false; break; }  //one failed filter invalidates and section
            }
            if (ofresult) return true;  //one successful and section validates or section
        }
        return false;
    }

    lfsMetadataToObject(metadata) {
        if (!metadata) return null;
        let raw = metadata.match(/^lfs\|([0-9]+)\|(.*)$/u);
        if (!raw) return null;
        let result = {};
        if (raw[1] == 2) {
            for (let pair of raw[2].split("|")) {
                let kv = pair.split(":");
                if (kv[0] == "author") {
                    let values = kv[1].split(",");
                    result.author = {id: values[0], name: values[1]};
                }
                if (kv[0] == "world") {
                    let values = kv[1].split(",");
                    result.world = {id: values[0], instanceId: values[1], name: values[2]};
                }
                if (kv[0] == "pos") {
                    result.pos = kv[1].split(",");
                }
                if (kv[0] == "rq") {
                    result.rq = kv[1];
                }
                if (kv[0] == "players") {
                    result.players = kv[1].split(";").map(player => {
                        let values = player.split(",");
                        return {id: values[0], x: parseFloat(values[1]), y: parseFloat(values[2]), z: parseFloat(values[3]), name: values[4]};
                    });
                }
            }
        }
        return result;
    }

    pngDecodetEXt(data) {
        if (data.data && data.name) {
            data = data.data;
        }

        data = Buffer.from(data);
          
        let name = '';
        let text = '';
        let i;

        for (i = 0; i < data.length; i++) {
            if (!data[i]) break;
            name += String.fromCharCode(data[i]);
        }

        text = data.toString('utf8', i + 1);
          
        return {
            keyword: name,
            text: text
        };
    }

    pngDecodeiTXt(data) {
        if (data.data && data.name) {
            data = data.data;
        }

        data = Buffer.from(data);

        let name = '';
        let text = '';
        let i;

        for (i = 0; i < data.length; i++) {
            if (!data[i]) break;
            name += String.fromCharCode(data[i]);
        }

        i += 3;
        while (data[i]) i+= 1;
        i += 1;
        while (data[i]) i+= 1;
        i += 1;

        text = data.toString('utf8', i);
          
        return {
            keyword: name,
            text: text
        };
    }

}


module.exports = ModVRChatPhotos;
