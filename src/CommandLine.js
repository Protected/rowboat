//Handle command line arguments

/* Feature options:
    args: A list of argument names to be consumed in order after the feature flag. Arguments are passed to the callback as an object.
    description: Single line description of the feature.
    details: Array of additional lines of text that provide more in-depth usage help.
*/

import logger from './Logger.js';

const PREFIX = "--";
const SEPARATOR = "--";

const FEATURE_REGEX = new RegExp("^" + PREFIX + "([^ ]+)");

var groups = {};
var features = {};

export function registerGroup(name, options) {
    options = options || {};
    if (groups[name]) {
        logger.warn("Redefining command line group '" + name + "'.");
    }
    groups[name] = {...options, name};
}

export function registerFeature(name, options, callback) {
    options = options || {};
    if (features[name]) {
        logger.warn("Redefining command line feature '" + name + "'.");
    }
    features[name] = {...options, name, callback};
    logger.info("Registered command line feature '" + name + "'.");
}

export async function parseAndExecuteArgs(args, context, cleanup) {
    if (!Array.isArray(args)) return false;

    let end = false;

    while (args.length) {
        let item = args.shift();
        if (item === SEPARATOR) return !end;

        let featurematch = item.match(FEATURE_REGEX);
        let name = featurematch ? featurematch[1] : null;

        if (!featurematch || !features[name]) {
            console.log("Unexpected argument:", item);
            return true;
        }

        let argnames = features[name].args || [];
        let minArgs = features[name].minArgs ?? argnames.length;
        let tocallback = {};

        for (let arg of argnames) {
            let nextdatum = args[0];
            if (nextdatum === undefined || nextdatum.match(FEATURE_REGEX)) {
                if (Object.keys(tocallback).length >= minArgs) break;
                console.log("Missing argument:", arg);
                return true;
            }
            tocallback[arg] = nextdatum;
            args.shift();
        }

        end = end || await (async () => features[name].callback(tocallback, context))();
    }

    if (cleanup) end = end || cleanup(context);

    return end;
}


const HELP_LEFT_COLUMN = 32;
const HELP_MIN_GAP = 4;
const HELP_GROUP_INDENT = 2;
const HELP_FEATURE_INDENT = 4;

const termwidth = process.stdout.columns;
const descwidth = termwidth - HELP_LEFT_COLUMN;

export function registerDefaultFeatures() {

    //Help command

    registerFeature("help", {
        description: "List all command line features"
    }, () => {

        let featurelist = Object.values(features);
        featurelist.sort((a, b) => {
            if (a.group != b.group) return (a.group || "").localeCompare(b.group || "");
            return a.name.localeCompare(b.name);
        });

        if (featurelist.length) {
            console.log("Command line features:\n");
        }

        let currentgroup = {name: ""};
        for (let options of featurelist) {
            
            //Group header
            if (options.group && options.group != currentgroup.name) {
                currentgroup = groups[options.group];
                console.log(`\n${" ".repeat(HELP_GROUP_INDENT)}${currentgroup.label}`);
                if (currentgroup.description) {
                    console.log(`${" ".repeat(HELP_FEATURE_INDENT)}${currentgroup.description}\n`);
                }
            }

            //Syntax
            let minArgs = options.minArgs ?? (options.args || []).length;
            let syntax = " ".repeat(HELP_FEATURE_INDENT) + PREFIX + options.name
                    + (options.args || []).map((arg, i) => i >= minArgs ? ` [${arg.toUpperCase()}]` : ` ${arg.toUpperCase()}`).join("");

            let fldescwidth = descwidth;
            if (syntax.length + HELP_MIN_GAP > HELP_LEFT_COLUMN) {
                syntax += " ".repeat(HELP_MIN_GAP);
                fldescwidth = termwidth - syntax.length - HELP_MIN_GAP;
            } else {
                syntax += " ".repeat(HELP_LEFT_COLUMN - syntax.length);
            }

            //Description
            let description = options.description + ".";
            if (description.length > fldescwidth) {
                syntax += description.substring(0, fldescwidth);
                description = description.substring(fldescwidth);
            } else {
                syntax += description;
                description = null;
            }

            console.log(syntax);

            while (description) {
                let next = description.substring(0, descwidth);
                description = description.substring(descwidth);
                console.log(`${" ".repeat(HELP_LEFT_COLUMN)}${next}`);
            }
        }

        return true;
    });

}
