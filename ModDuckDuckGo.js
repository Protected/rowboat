/* Module: DuckDuckGo -- Adds a command, "duck", which performs a DuckDuckGo query. */

const Module = require('./Module.js');
const DDG = require('node-ddg-api').DDG;

try {
    var discord = require('discord.js');
} catch (err) {}

class ModDuckDuckGo extends Module {

    get requiredParams() { return [
    ]; }
    
    get optionalParams() { return [
        'relatedTopics',        //Maximum amount of returned related topics
        'relatedSubtopics',     //Maximum amount of subtopics per category
        'relatedCategories',    //Maximum amount of categories
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('DuckDuckGo', name);
        
        //Note: These values help prevent crashes on Discord due to richembed data limits, which are:
        //2048 chars on text, 1024 chars on field value, and 6000 bytes of data
        this._params['relatedTopics'] = 6;
        this._params['relatedSubtopics'] = 3;
        this._params['relatedCategories'] = 3;

    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

      
        //Register callbacks
        
        this.mod('Commands').registerCommand(this, 'duck', {
            description: "DuckDuckGo query.",
            args: ["query", true],
            details: [
                "Prefix your query with a + to use strict mode, which skips disambiguations and doesn't include related topics."
            ],
            types: ["regular"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let ddg = new DDG("Rowboat");
            let isDiscord = (env.envName == "Discord" && discord);
            let query = args.query.join(" ");
            let strict = /^\+(.*)/.exec(query);
            if (strict) query = strict[1];

            ddg.instantAnswer(query, {
                "no_redirects": 1,
                "no_html": 1,
                "skip_disambig": (strict ? 1 : 0)
            }, (err, answ) => {

                if (err) {
                    this.log('warn', err);
                    return;
                }

                if (answ.Redirect) {
                    ep.reply(answ.Redirect);
                    return;
                }

                let attrib = "Answer from DuckDuckGo";
                if (answ.AbstractSource) {
                    attrib += " and " + answ.AbstractSource;
                }

                let url = "https://duckduckgo.com/";
                if (answ.AbstractURL) {
                    url = answ.AbstractURL;
                }

                let text = answ.AbstractText;
                if (!text) {
                    if (!answ.RelatedTopics.length) {
                        text = "No information.";
                    } else {
                        text = "";
                    }
                }

                if (isDiscord) {
                    //Discord-specific reply with colors, images and links

                    for (let result of answ.Results) {
                        text += "\n[" + result.Text + "](" + result.FirstURL + ")";
                    }

                    let re = new discord.RichEmbed()
                        .setColor(text ? [102, 204, 51] : [222, 88, 51])
                        .setImage(answ.Image)
                        .setTitle(answ.Heading)
                        .setDescription(text)
                        .setURL(url)
                        .setFooter(attrib);

                    if (answ.Infobox && answ.Infobox.content) {
                        for (let infoitem of answ.Infobox.content) {
                            if (infoitem.data_type == "string") {
                                re.addField(infoitem.label, infoitem.value, true);
                            }
                        }
                    }

                    try {
                        ep.reply(re);
                    } catch (e) {}

                    //"See also" box with extra links

                    if (strict) return true;

                    let more = new discord.RichEmbed()
                        .setColor([253, 210, 10])
                        .setTitle(text ? "See also" : "Disambiguation");

                    let seealso = "";

                    for (let i = 0; i < answ.RelatedTopics.length && i < this.param("relatedTopics"); i++) {
                        let rel = answ.RelatedTopics[i];
                        if (rel.Name) {
                            if (more.fields.length >= this.param("relatedCategories")) continue;
                            let subsee = "";
                            for (let j = 0; j < rel.Topics.length && j < this.param("relatedSubtopics"); j++) {
                                let subrel = rel.Topics[j];
                                subsee += "[" + subrel.Text + "](" + subrel.FirstURL + ")\n";
                            }
                            more.addField(rel.Name, subsee);
                        } else {
                            seealso += "[" + rel.Text + "](" + rel.FirstURL + ")\n";
                        }
                    }

                    if (seealso || more.fields.length) {
                        more.setDescription(seealso);
                        try {
                            ep.reply(more);
                        } catch (e) {}
                    }

                } else {
                    //Plaintext for other environments

                    ep.reply("**" + answ.Heading + "** - " + attrib + " ( " + url + " )");
                    ep.reply(text);
                    
                    if (answ.Infobox && answ.Infobox.content) {
                        for (let infoitem of answ.Infobox.content) {
                            if (infoitem.data_type == "string") {
                                ep.reply("__" + infoitem.label + "__: " + infoitem.value);
                            }
                        }
                    }

                    for (let result of answ.Results) {
                        ep.reply("__" + result.Text + "__: " + result.FirstURL);
                    }

                }


            });
        
            return true;
        });
      
        return true;
    };

}


module.exports = ModDuckDuckGo;
