/* Module: VRChatPhotos -- Manages a channel for sharing VRChat photos and screenshots. */

const moment = require('moment');
const random = require('meteor-random');
const { MessageEmbed } = require('discord.js');
const pngextract = require('png-chunks-extract');
const fs = require('fs');

const Module = require('../Module.js');

const PERM_ADMIN = 'administrator';

const MAX_FIELDLEN = 1024;

const ZWSP = "​";  //Zero-width space (\u200b)

class ModVRChatPhotos extends Module {

    get isMultiInstanceable() { return true; }

    get requiredParams() { return [
        "env",
        "photochan",            //ID of text channel for photos
    ]; }
    
    get optionalParams() { return [
        "name",                 //Album name override
        "deleteemoji",          //Emoji for deleting things
        "backuppath",           //Subdirectory for backups

        "usewebhook",           //Use a webhook to re-emit photos
        "embedwithoutmeta",     //Whether to re-emit photos without metadata

        /* Contest */
        "contestchan",          //ID of text channel for contest candidates
        "nominationrole",       //Role required for nominating
        "candidatemin",         //Minimum timestamp for eligible candidates
        "candidatemax",         //Maximum timestamp for eligible candidates
        "maxnominations",       //Maximum candidates per member
        "nominationemoji",      //Reaction emoji used for nominating
        "contestemojis",        //List of emojis allowed to "stick" in the contest channel (for votes)
        "candidatedelete"       //Whether candidates can be deleted using a reaction
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

    get contestchan() {
        return this.denv.server.channels.cache.get(this.param("contestchan"));
    }

    constructor(name) {
        super('VRChatPhotos', name);
     
        this._params["name"] = name.toLowerCase();
        this._params["deleteemoji"] = "❌";

        this._params["usewebhook"] = true;
        this._params["embedwithoutmeta"] = false;

        this._params["maxnominations"] = 3;
        this._params["nominationemoji"] = "⭐";
        this._params["contestemojis"] = [];
        this._params["candidatedelete"] = true;

        this._index = {};  //{ID: MESSAGE, ...}

        this._contestindex = {};  //{MESSAGEID: {contestant: USERID, msg: MESSAGE, original: ORIGMESSAGEID}, ...}
        this._contestants = {};  //{USERID: [MESSAGEID, ...]}
        this._contestoriginals = {};  //{ORIGMESSAGEID: MESSAGEID, ...}
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        
        //# Register Discord callbacks

        let messageReactionAddHandler = async (messageReaction, user) => {
            if (user.id == this.denv.server.me.id) return;

            if (this.photochan && messageReaction.message.channel.id == this.photochan.id) {

                if (messageReaction.message.partial) await messageReaction.message.fetch();

                //Delete photos
                if (messageReaction.emoji.name == this.param("deleteemoji")) {
                    let owners = Object.values(this.extractOwnersFromPicture(messageReaction.message));
                    if (owners && owners.find(owner => owner == user.id)) {
                        messageReaction.message.delete();
                    } else {
                        messageReaction.users.remove(user.id);
                    }
                }

                //Create contest candidate
                if (this.contestchan && messageReaction.emoji.name == this.param("nominationemoji") && this.messageHasPhotos(messageReaction.message)) {
                    if (this._contestants[user.id] && this._contestants[user.id].length >= this.param("maxnominations")) {
                        this.denv.msg(user.id, "You have reached the maximum amount of nominations. Delete an existing candidate first.");
                    } else {
                        let member = await this.denv.server.members.fetch(user);
                        if (!this.param("nominationrole") || member.roles.cache.get(this.param("nominationrole"))) {
                            let ct = messageReaction.message.createdTimestamp / 1000;
                            let et = messageReaction.message.editedTimestamp ? messageReaction.message.editedTimestamp / 1000 : ct;
                            if (this.param("candidatemin") && (ct < this.param("candidatemin") || et < this.param("candidatemin"))
                                    || this.param("candidatemax") && (ct > this.param("candidatemax") || et > this.param("candidatemax"))) {
                                this.denv.msg(user.id, "That photo was shared or edited outside the contest period.");
                            } else if (this._contestoriginals[messageReaction.message.id]) {
                                this.denv.msg(user.id, "That photo is already nominated!");
                            } else {
                                let owners = this.extractOwnersFromPicture(messageReaction.message);
                                let fields = this.getPhotoMessageFields(messageReaction.message);
                                let candidate = await this.bakeCandidate(member, owners, fields, this.getPhotoMsgURL(messageReaction.message.id));
                                if (candidate) {
                                    this._contestindex[candidate.id] = {contestant: user.id, msg: candidate, original: messageReaction.message.id};
                                    if (!this._contestants[user.id]) this._contestants[user.id] = [];
                                    this._contestants[user.id].push(candidate.id);
                                    this._contestoriginals[messageReaction.message.id] = candidate.id;
                                }
                            }
                        }
                    }
                    messageReaction.users.remove(user.id);
                }

            }
            
            if (this.contestchan && messageReaction.message.channel.id == this.contestchan.id) {

                if (messageReaction.message.partial) await messageReaction.message.fetch();

                //Delete contest candidate
                if (messageReaction.emoji.name == this.param("deleteemoji") && this.param("candidatedelete")) {
                    let contestant = this.extractContestantFromPicture(messageReaction.message);
                    if (contestant == user.id) {
                        let message = messageReaction.message;
                        message.delete()
                            .then(() => {
                                let contestant = this._contestindex[message.id].contestant;
                                this._contestants[contestant] = this._contestants[contestant].filter(entry => entry != message.id);
                                if (this._contestoriginals[this._contestindex[message.id].original]) delete this._contestoriginals[this._contestindex[message.id].original];
                                delete this._contestindex[message.id];
                            });
                        return;
                    }
                }

                if (!this.param("contestemojis").find(ce => ce == messageReaction.emoji.name)) {
                    messageReaction.users.remove(user.id);
                }
            }

        };


        let messageHandler = (env, type, message, authorid, channelid, messageObject) => {
            if (env.name != this.param("env") || type != "regular") return;
            if (channelid != this.photochan?.id) return;
                
            //Sharing to photochan

            if (this.messageHasAttachmentPhotos(messageObject)) {
                this.reemitMessage(messageObject);

                return true;
            }

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
                return;
            }

            if (this._contestindex[message.id]) {
                let contestant = this._contestindex[message.id].contestant;
                this._contestants[contestant] = this._contestants[contestant].filter(entry => entry != message.id);
                if (this._contestoriginals[this._contestindex[message.id].original]) delete this._contestoriginals[this._contestindex[message.id].original];
                delete this._contestindex[message.id];
                return;
            }

            if (this._contestoriginals[message.id]) {
                delete this._contestoriginals[message.id];
                return;
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

            //Prefetch and index contest channel contents
            
            if (this.contestchan) {

                this._contestindex = {};
                this._contestants = {};
                this._contestoriginals = {};

                this.denv.scanEveryMessage(this.contestchan, (message) => {
                    if (this.messageHasPhotos(message)) {
                        let contestant = this.extractContestantFromPicture(message);
                        if (contestant) {
                            let original = this.extractOriginalFromCandidatePicture(message);
                            this._contestindex[message.id] = {contestant: contestant, msg: message, original: original};
                            if (!this._contestants[contestant]) this._contestants[contestant] = [];
                            this._contestants[contestant].push(message.id);
                            if (original) this._contestoriginals[original] = message.id;
                        }
                    }
                });

            }

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
            ep.ok();

            return true;
        });

        this.mod('Commands').registerCommand(this, 'vrcfix recandidate' + this.param("name"), {
            description: "Re-bakes a contest candidate message (edits the original).",
            args: ["messageid"],
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this.contestchan) {
                ep.reply("There is no contest channel.");
                return true;
            }

            let message = await this.contestchan.messages.fetch(args.messageid);
            if (!message) {
                ep.reply("Candidate message not found.");
                return true;
            }

            let photomessage = await this.getPhotoMsgFromURL(message.content);
            if (!photomessage) {
                ep.reply("Original message not found in candidate.");
                return true;
            }

            let owners = this.extractOwnersFromPicture(photomessage);
            let fields = this.getPhotoMessageFields(photomessage);
            await this.bakeCandidate(null, owners, fields, this.getPhotoMsgURL(photomessage.id), message);

            ep.ok();

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

            env.msg(channel, this.getPhotoMsgURL(message.id), pickembed);

            return true;
        });


        this.mod('Commands').registerRootExtension(this, 'VRChat', 'vrcsave');

        this.mod('Commands').registerCommand(this, 'vrcsave ' + this.param("name"), {
            description: "Back up the photos from the " + this.param("name") + " album.",
            permissions: [PERM_ADMIN],
            type: ["private"]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this.photochan) return true;

            if (!this.param("backuppath")) {
                ep.reply("There is no backup path.");
                return true;
            }

            let counter = 0;
            let queue = [];

            for (let id in this._index) {
                let message = this._index[id];
                queue.push(message);
            }

            let existing = await fs.promises.readdir(this.param("backuppath"));
            existing = existing.map(filename => {
                let extrid = filename.match(/([0-9]+)(\.[^.]+)?$/);
                if (extrid) return extrid[1];
            });

            queue = queue.filter(queued => !existing.find(test => test == queued.id));

            let inProgress = {};
            let downloadTimer = setInterval(function() {
                if (Object.keys(inProgress).length >= 2) {  //maximum simultaneous
                    return;
                }

                let message = queue.pop();
                if (!message) {
                    clearInterval(downloadTimer);
                    ep.reply("Done!");
                    return;
                }

                let newdownload = this.downloadMessagePhoto(message, this.param("backuppath"), () => {
                    delete inProgress[message.id];
                    counter += 1;
                    if (!(counter % 50)) {
                        ep.reply("Downloaded: " + counter);
                    }
                }, (e) => {
                    delete inProgress[message.id];
                    this.log("Failed " + message.id + ": " + e);
                });

                if (!newdownload) {
                    return;
                }

                inProgress[message.id] = newdownload;

            }.bind(this), 2000);

            ep.reply("Starting downloads, please wait...");

            return true;
        });


        this.mod('Commands').registerRootExtension(this, 'VRChat', 'vrcount');

        this.mod('Commands').registerCommand(this, 'vrcount ' + this.param("name"), {
            description: "Returns the current amount of photos in the " + this.param("name") + " album."
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let count = Object.keys(this._index).length;
            if (count) {
                ep.reply(env.idToDisplayName(userid) + ": " + count);
            } else{
                ep.reply(env.idToDisplayName(userid) + ": There are no photos in this album yet.");
            }

            return true;
        });

        if (this.param("contestchan")) {

            this.mod('Commands').registerCommand(this, 'vrcount ' + this.param("name") + " candidates", {
                description: "Returns the current amount of contest candidates associated with the " + this.param("name") + " album."
            }, (env, type, userid, channelid, command, args, handle, ep) => {
    
                let count = Object.keys(this._contestindex).length;
                if (count) {
                    ep.reply(env.idToDisplayName(userid) + ": " + count);
                } else{
                    ep.reply(env.idToDisplayName(userid) + ": There are no contest candidates yet.");
                }
    
                return true;
            });

        }


        
        return true;
    };



    // # Module code below this line #


    //Handling of messages with pictures

    messageHasAttachmentPhotos(message) {
        if (!message) return false;
        for (let attachment of message.attachments.values()) {
            if (attachment.width) return true;
        }
        return false;
    }

    messageHasPhotos(message) {
        if (!message) return false;
        for (let embed of message.embeds) {
            if (embed.type == "rich" && embed.image) return true;
        }
        for (let attachment of message.attachments.values()) {
            if (attachment.width) return true;
        }
        return false;
    }

    getMessageAttachmentPhoto(message, onPhoto, onError) {
        if (!message || !onPhoto) return null;

        for (let attachment of message.attachments.values()) {
            if (!attachment.width) continue;

            return this.urlget(attachment.url, {buffer: true})
                .then((data) => onPhoto(attachment, data))
                .catch((e) => onError ? onError(e) : undefined)
                ;
        }

        return null;
    }

    getMessageEmbedPhoto(message, onPhoto, onError) {
        if (!message || !onPhoto) return null;

        for (let embed of message.embeds) {
            if (embed.type != "rich" && embed.type != "image" || !embed.image) continue;

            return this.urlget(embed.image.url, {buffer: true})
                .then((data) => onPhoto(embed.image, data))
                .catch((e) => onError ? onError(e) : undefined)
                ;
        }

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

        for (let attachment of message.attachments.values()) {
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
                } else if (!this.param("embedwithoutmeta")) {
                    this._index[message.id] = message;
                    return;
                }
            }

            return message.delete()
                .then(() => this.bakePicture(attachment.name || "photo.png", data, message.member, metadata))
                .then((message) => { this._index[message.id] = message; })
                .catch((e) => {  });
        });
    }

    downloadMessagePhoto(message, targetpath, onEnd, onFail) {
        if (!message || !this.messageHasPhotos(message) || !targetpath) return null;

        let handleDownloadedPhoto = (filename, data) => {
            let metadata = null;
            if (filename && filename.match(/\.png$/i)) {
                try {
                    metadata = pngextract(data)
                        .filter(chunk => chunk.name == "tEXt" || chunk.name == "iTXt")
                        .map(chunk => chunk.name == "tEXt" ? this.pngDecodetEXt(chunk.data) : this.pngDecodeiTXt(chunk.data))
                        .find(text => text.keyword == "Description" && text.text.match(/^lfs|2|/));
                } catch (e) {}
                if (metadata) {
                    metadata = this.lfsMetadataToObject(metadata.text);
                }
            }

            let targetfile = targetpath + "/vrcp_" + moment(message.createdTimestamp).format("Y-MM-DD_HH-mm");
            if (metadata) {
                targetfile += "_" + metadata.author.name + "_" + metadata.world.name;
            } else {
                let owners = this.extractOwnersFromPicture(message);
                targetfile += "_" + this.denv.idToDisplayName(owners.author || owners.sharedBy || "") + "_";
            }
            targetfile += "_" + message.id;

            let ext = filename.match(/\.[a-z0-9]+$/i);
            if (ext) {
                targetfile += ext[0];
            }
            
            fs.writeFile(targetfile, data, () => { if (onEnd) onEnd(targetfile); });
        }

        if (this.messageHasAttachmentPhotos(message)) {
            return this.getMessageAttachmentPhoto(message, (attachment, data) => {
                handleDownloadedPhoto(attachment.name, data);
            }, onFail);
        } else {
            return this.getMessageEmbedPhoto(message, (embedimage, data) => {
                handleDownloadedPhoto(embedimage.url.split("/").pop(), data);
            }, onFail);
        }

    }

    
    //Picture metadata

    async bakePicture(name, data, member, metadata) {
        if (!name || !data || !data.length || !member) return null;

        let vrchat = this.mod("VRChat");

        let sharedBy = this.denv.idToDisplayName(member.id);

        let emb = new MessageEmbed();

        if (metadata) {
            let sbperson = vrchat.getPerson(member.id);
            if (this.param("usewebhook") || sbperson && metadata.author.id == sbperson.vrc) {
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
                    emb.addField(fieldcount ? ZWSP : "With", val);
                    fieldcount += 1;
                    val = person;
                }
                if (val) emb.addField(fieldcount ? ZWSP : "With", val);
            }

            emb.addField("Location", "[" + metadata.world.name + "](https://vrchat.com/home/world/" + metadata.world.id + ")", true);
        }

        if (sharedBy) {
            let msgurl = vrchat.getPersonMsgURL(member.id);
            if (msgurl) sharedBy = "[" + sharedBy + "](" + msgurl + ")";
            emb.addField("Shared by", sharedBy, true);
        }

        emb.setImage("attachment://" + encodeURI(name));

        try {
            if (this.param("usewebhook")) {
                return this.denv.getWebhook(this.photochan, member).then((webhook) => webhook.send({embeds: [emb], files: [{name: name, attachment: data}]}));
            } else {
                return this.denv.msg(this.photochan, {embeds: [emb], files: [{name: name, attachment: data}]});
            }
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
        
        if (!emb || !emb.image) {
            
            for (let attachment of message.attachments.values()) {
                if (attachment.width) {
                    return {
                        sharedBy: message.author?.id
                    }
                }
            }

            return null;
        }

        let results = {};
        for (let field of emb.fields) {
            if (field.name.match(/^shared by$/i)) {
                let extrs = field.value.match(/\[[^\]]+\]\(https:\/\/discord\.com\/channels\/[0-9]+\/[0-9]+\/([0-9]+)\)/);
                if (extrs) {
                    let person = vrchat.findPersonByMsg(extrs[1]);
                    if (person) results.sharedBy = person;
                }
            }
            if (field.name.match(/^with$/i)) {
                let extrs = field.value.match(/\[[^\]]*__[^\]]+__[^\]]*\]\(https:\/\/discord\.com\/channels\/[0-9]+\/[0-9]+\/([0-9]+)\)/);
                if (extrs) {
                    let person = vrchat.findPersonByMsg(extrs[1]);
                    if (person) results.author = person;
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

    async getPhotoMsgFromURL(url) {
        if (!url || !this.photochan) return null;
        let match = url.match(/https:\/\/discord\.com\/channels\/([0-9]+)\/([0-9]+)\/([0-9]+)/);
        if (!match) return null;
        if (match[1] != this.denv.server.id) return null;
        if (match[2] != this.photochan.id) return null;
        return this.photochan.messages.fetch(match[3]);
    }

    randomPhoto(makefilter) {
        return this.randomEntry(this._index, makefilter ? makefilter(this._index) : undefined);
    }

    //Contest

    async bakeCandidate(member, owners, fields, messageurl, existing) {
        if (!member && !existing || !owners || !fields || Object.keys(owners).length < 1) return null;

        let vrchat = this.mod("VRChat");

        let nominate, label;
        if (owners.author) {
            nominate = owners.author;
            label = "Author";
        } else if (owners.sharedBy) {
            nominate = owners.sharedBy;
            label = "Shared by";
        }

        if (!nominate) return null;

        let emb;
        if (existing) {
            for (let checkembed of existing.embeds) {
                if (checkembed.type == "rich") {
                    emb = checkembed;
                    break;
                }
            }
        }

        let nominatedfield = null;
        if (emb) {
            nominatedfield = this.embedFieldByName(emb, "Nominated by");
        } else {
            emb = new MessageEmbed();
        }

        emb.fields = [];

        let msgurl = vrchat.getPersonMsgURL(nominate);
        if (msgurl) {
            emb.addField(label, "[" + this.denv.idToDisplayName(nominate) + "](" + msgurl + ")", true);
        } else {
            emb.addField(label, this.denv.idToDisplayName(nominate), true);
        }

        if (member) {
            msgurl = vrchat.getPersonMsgURL(member.id);
            if (msgurl) {
                emb.addField("Nominated by", "[" + this.denv.idToDisplayName(member.id) + "](" + msgurl + ")", true);
            } else {
                emb.addField("Nominated by", this.denv.idToDisplayName(member.id), true);
            }
        } else if (nominatedfield) {
            emb.addField("Nominated by", nominatedfield.value, true);
        }

        emb.setImage(fields.image);

        try {
            if (existing) {
                return await existing.edit(messageurl, {embeds: [emb]});
            } else {
                return await this.contestchan.send(messageurl, {embeds: [emb]});
            }
        } catch (e) {
            this.log("error", "Failed to bake candidate: " + JSON.stringify(e));
        }
    }



    extractContestantFromPicture(message) {
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

        let results = {};
        for (let field of emb.fields) {
            if (field.name.match(/^nominated by$/i)) {
                let extrs = field.value.match(/\[[^\]]+\]\(https:\/\/discord\.com\/channels\/[0-9]+\/[0-9]+\/([0-9]+)\)/);
                if (extrs) {
                    let person = vrchat.findPersonByMsg(extrs[1]);
                    if (person) return person;
                }
            }
        }

        return null;
    }

    extractOriginalFromCandidatePicture(message) {
        if (!message || !message.content) return null;
        let extr = message.content.match(/https:\/\/discord\.com\/channels\/[0-9]+\/[0-9]+\/([0-9]+)/);
        if (extr) return extr[1];
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
