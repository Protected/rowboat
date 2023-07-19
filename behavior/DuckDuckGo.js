/* Module: DuckDuckGo -- Adds a command, "duck", which performs a DuckDuckGo query. */

const Module = require('../Module.js');
const DDG = require('duck-duck-scrape');
const moment = require('moment');

const BASIC_URL = "https://duckduckgo.com/";

const COLORS = {
    main: [222, 88, 51],
    video: [255, 0, 0],
    news: [108, 205, 59],
    old_news: [156, 178, 146],
    image: [141, 157, 227]
};

try {
    var { EmbedBuilder } = require('discord.js');
} catch (err) {}

class ModDuckDuckGo extends Module {

    get requiredParams() { return [
    ]; }
    
    get optionalParams() { return [
        'results',              //Amount of returned results by default
        'maxResults'            //Maximum amount of returned results using --count
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('DuckDuckGo', name);
        
        this._params['results'] = 1;
        this._params['maxResults'] = 5;
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

      
        //Register callbacks
        
        this.mod('Commands').registerCommand(this, 'duck', {
            description: "DuckDuckGo query.",
            args: ["query", true],
            details: [
                "Prefix the query with these parameters to modify your search:",
                "--type normal|images|news|videos : Change the search type (default is normal).",
                "--safe strict|moderate|off : Change the safesearch setting (default is moderate).",
                "--time a|y|m|w|d : Restrict the time range of the results (default is a).",
                "--count N : Change the amount of returned results (default is " + this.param("results") + ")",
                "--imgType all|photo|clipart|gif|transparent",
                "--imgSize all|small|medium|large|wallpaper",
                "--imgLayout all|square|tall|wide",
                "--vidDefinition any|high|standard",
                "--vidDuration any|short|medium|long"
            ],
            types: ["regular"]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
        
            let isDiscord = (env.envName == "Discord");
            let options = this.parseQuery(args.query);

            if (options.error) {
                ep.reply("Query error: " + options.error);
                return true;
            }

            let outcome;
            try {
                outcome = await options.func(options.query, options.pass);
            } catch (err) {
                this.log('warn', err);

                ep.reply("There was an error when trying to perform the search.");
                return true;
            }

            if (outcome?.noResults) {
                ep.reply("Your query didn't yield any results.");
                return true;
            }

            let count = 0;

            for (let result of outcome.results) {
                let presentation;

                if (typeof result.duration === "string") {
                    presentation = this.buildVideo(result, isDiscord);
                } else if (typeof result.syndicate === "string") {
                    presentation = this.buildNews(result, isDiscord);
                } else if (result.width) {
                    presentation = this.buildImage(result, isDiscord);
                } else {
                    presentation = this.buildResult(result, isDiscord);
                }

                ep.reply(presentation);

                count += 1;
                if (count >= options.count) break;
            }

            if (outcome.news?.length) {
                for (let result of outcome.news) {
                    if (count >= options.count) break;
                    ep.reply(this.buildNews(result, isDiscord));
                    count += 1;
                }
            }

            if (outcome.images?.length) {
                for (let result of outcome.images) {
                    if (count >= options.count) break;
                    ep.reply(this.buildImage(result, isDiscord));
                    count += 1;
                }
            }

            if (outcome.videos?.length) {
                for (let result of outcome.videos) {
                    if (count >= options.count) break;
                    ep.reply(this.buildVideo(result, isDiscord));
                    count += 1;
                }
            }
        
            return true;
        });
      
        return true;
    }


    // # Module code below this line #


    parseQuery(words) {
        let options = {
            query: "",
            func: DDG.search,
            count: this.param("results"),
            pass: {
                safeSearch: DDG.SafeSearchType.MODERATE,
                time: DDG.SearchTimeType.ALL
            },
            error: null
        };
        if (!words || !words.length) return {query, options};

        while (words.length) {
            let next = words[0];
            if (next.length < 2 || next.substring(0, 2) !== "--") {
                break;
            }
            words.shift();
            if (next === "--") {
                break;
            }

            let param = words.shift();
            if (param === undefined) {
                options.error = "No argument for " + next;
                break;
            }

            if (next === "--type") {
                if (param.match(/^im(age|g)s?$/i)) {
                    options.func = DDG.searchImages;
                    options.pass = {
                        ...options.pass,
                        type: DDG.ImageType.ALL,
                        size: DDG.ImageSize.ALL,
                        layout: DDG.ImageLayout.ALL
                    };
                } else if (param.match(/^news$/i)) {
                    options.func = DDG.searchNews;
                } else if (param.match(/^vid(eos?)$/i)) {
                    options.func = DDG.searchVideos;
                    options.pass = {
                        ...options.pass,
                        definition: DDG.VideoDefinition.ANY,
                        duration: DDG.VideoDuration.ANY
                    };
                } else if (!param.match(/^(normal|search|default)$/i)) {
                    options.error = "Invalid parameter for " + next;
                    break;
                }
                continue;
            }

            if (next === "--safe") {
                if (param.match(/^strict$/i)) {
                    options.pass.safeSearch = DDG.SafeSearchType.STRICT
                } else if (param.match(/^(off|disabled?|no)$/i)) {
                    options.pass.safeSearch = DDG.SafeSearchType.OFF
                } else if (!param.match(/^(normal|moderate|default)$/i)) {
                    options.error = "Invalid parameter for " + next;
                    break;
                }
                continue;
            }

            if (next === "--time") {
                if (param.match(/^Y$/i)) {
                    options.pass.time = DDG.SearchTimeType.YEAR;
                } else if (param.match(/^M$/i)) {
                    options.pass.time = DDG.SearchTimeType.MONTH;
                } else if (param.match(/^W$/i)) {
                    options.pass.time = DDG.SearchTimeType.WEEK;
                } else if (param.match(/^D$/i)) {
                    options.pass.time = DDG.SearchTimeType.DAY;
                } else if (!param.match(/^(normal|A|default)$/i)) {
                    options.error = "Invalid parameter for " + next;
                    break;
                }
                continue;
            }

            if (next === "--count") {
                let count = parseInt(param);
                if (!isNaN(count) && count > 0 && count <= this.param("maxResults")) {
                    options.count = count;
                } else {
                    options.error = "Invalid parameter for " + next + ": Must be a number between 1 and " + this.param("maxResults");
                    break;
                }
                continue;
            }

            if (next === "--imgType" && options.func === DDG.searchImages) {
                if (param.match(/^photo(graph)?$/i)) {
                    options.pass.type = DDG.ImageType.PHOTOGRAPH;
                } else if (param.match(/^clipart$/i)) {
                    options.pass.type = DDG.ImageType.CLIPART;
                } else if (param.match(/^(gif|animated)$/i)) {
                    options.pass.type = DDG.ImageType.GIF;
                } else if (param.match(/^transparent$/i)) {
                    options.pass.type = DDG.ImageType.TRANSPARENT;
                } else if (!param.match(/^(everything|any|all|default)$/i)) {
                    options.error = "Invalid parameter for " + next;
                    break;
                }
                continue;
            }

            if (next === "--imgSize" && options.func === DDG.searchImages) {
                if (param.match(/^(small(est)?|tiny)$/i)) {
                    options.pass.size = DDG.ImageSize.SMALL;
                } else if (param.match(/^(medium|average)$/i)) {
                    options.pass.size = DDG.ImageSize.MEDIUM;
                } else if (param.match(/^(large|big)$/i)) {
                    options.pass.size = DDG.ImageSize.LARGE;
                } else if (param.match(/^(largest|wallpaper|desktop)$/i)) {
                    options.pass.size = DDG.ImageSize.WALLPAPER;
                } else if (!param.match(/^(everything|any|all|default)$/i)) {
                    options.error = "Invalid parameter for " + next;
                    break;
                }
                continue;
            }

            if (next === "--imgLayout" && options.func === DDG.searchImages) {
                if (param.match(/^(square|balanced)$/i)) {
                    options.pass.layout = DDG.ImageLayout.SQUARE;
                } else if (param.match(/^(tall|portrait)$/i)) {
                    options.pass.layout = DDG.ImageLayout.TALL;
                } else if (param.match(/^(wide|landscape)$/i)) {
                    options.pass.layout = DDG.ImageLayout.WIDE;
                } else if (!param.match(/^(everything|any|all|default)$/i)) {
                    options.error = "Invalid parameter for " + next;
                    break;
                }
                continue;
            }

            if (next === "--vidDefinition" && options.func === DDG.searchVideos) {
                if (param.match(/^(high|hd)$/i)) {
                    options.pass.definition = DDG.VideoDefinition.HIGH;
                } else if (param.match(/^(standard|sd)$/i)) {
                    options.pass.definition = DDG.VideoDefinition.STANDARD;
                } else if (!param.match(/^(everything|any|all|default)$/i)) {
                    options.error = "Invalid parameter for " + next;
                    break;
                }
                continue;
            }

            if (next === "--vidDuration" && options.func === DDG.searchVideos) {
                if (param.match(/^(short|small|quick)$/i)) {
                    options.pass.duration = DDG.VideoDuration.SHORT;
                } else if (param.match(/^(medium|average|intermediate)$/i)) {
                    options.pass.duration = DDG.VideoDuration.MEDIUM;
                } else if (param.match(/^(long|big)$/i)) {
                    options.pass.duration = DDG.VideoDuration.LONG;
                } else if (!param.match(/^(everything|any|all|default)$/i)) {
                    options.error = "Invalid parameter for " + next;
                    break;
                }
                continue;
            }

            options.error = "Unknown option " + next;
            break;
        }
        
        options.query = words.join(" ");
        return options;
    }


    buildResult(result, isDiscord) {
        if (!isDiscord) {
            return "**" + result.title + "**: " + result.url + "\n" + result.description;
        }

        return new EmbedBuilder()
            .setColor(COLORS.main)
            .setTitle(result.title)
            .setDescription(this.stylesHtmlToMarkdown(result.description))
            .setURL(result.url)
            .setFooter({
                iconURL: result.icon,
                text: result.hostname
            });
    }

    buildNews(result, isDiscord) {
        if (!isDiscord) {
            return "**" + result.title + "**: " + result.url + "\n" + result.excerpt;
        }

        return new EmbedBuilder()
            .setColor(result.isOld ? COLORS.old_news : COLORS.news)
            .setTitle(result.title)
            .setDescription(this.stylesHtmlToMarkdown(result.excerpt))
            .setURL(result.url)
            .setThumbnail(result.image || null)
            .setFooter({
                text: result.syndicate + " - " + result.relativeTime
            });
    }

    buildImage(result, isDiscord) {
        if (!isDiscord) {
            return "**" + result.title + "**: " + result.url + " (" + result.width + " x " + result.height + ")";
        }

        let embed = new EmbedBuilder()
            .setColor(COLORS.image)
            .setTitle(result.title)
            .setURL(result.url)
            .setImage(result.thumbnail)
            .setFooter({
                text: result.source
            });

        embed.addFields({name: "Width", value: result.width.toString(), inline: true},
            {name: "Height", value: result.height.toString(), inline: true});

        return embed;
    }

    buildVideo(result, isDiscord) {
        if (!isDiscord) {
            return "**" + result.title + "**: " + result.url + " (" + result.duration + ")\n" + result.description;
        }

        let embed = new EmbedBuilder()
            .setColor(COLORS.video)
            .setTitle(result.title)
            .setDescription(this.stylesHtmlToMarkdown(result.description))
            .setURL(result.url)
            .setImage(result.image)
            .setFooter({
                text: result.publishedOn + " - " + moment(result.published).from(moment())
            });

        embed.addFields({name: "Duration", value: result.duration, inline: true});

        if (typeof result.viewCount === "number") {
            embed.addFields({name: "Views", value: result.viewCount.toString(), inline: true});
        }

        return embed;
    }

    stylesHtmlToMarkdown(text) {
        if (!text) return text;
        
        const stylemap = [
            {html: /<b>(.*?)<\/b>/i, md: "**$1**"},
            {html: /<i>(.*?)<\/i>/i, md: "*$1*"},
            {html: /<u>(.*?)<\/u>/i, md: "__$1__"},
            {html: /<s>(.*?)<\/s>/i, md: "~~$1~~"},
            {html: /<h1>(.*?)<\/h1>/i, md: "# $1"},
            {html: /<h2>(.*?)<\/h2>/i, md: "## $1"},
            {html: /<h3>(.*?)<\/h3>/i, md: "### $1"},
            {html: /<pre>(.*?)<\/pre>/i, md: "```\n$1\n```"},
        ];
        
        let modify = text;
        
        for (let item of stylemap) {
            do {
                text = modify;
                modify = text.replace(item.html, item.md);
            } while (text != modify);
        }
        
        return text;
    }

}


module.exports = ModDuckDuckGo;
