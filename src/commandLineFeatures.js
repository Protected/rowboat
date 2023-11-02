import { registerDefaultFeatures, registerGroup, registerFeature } from './CommandLine.js';
import { ConfigFail } from './EditConfig.js';

//Command line features (expect context with config, core)

export default function registerCommandLineFeatures() {  //---


registerDefaultFeatures();

function editConfig(context) {
    if (!context.editConfig) {
        context.editConfig = context.config.loadEditConfig();
        context.editConfig.core = context.core;
    }
    return context.editConfig;
}

function genericFeedback(result, label) {
    if (result == ConfigFail.CONFIG_NOT_FOUND) {
        console.log("These is no such " + label + ".");
    } else if (result == ConfigFail.TYPE_NOT_FOUND) {
        console.log("The type of this " + label + " could not be loaded.");
    } else {
        console.log("OK.");
    }
}

registerFeature("config", {
    description: "Use a custom config filename",
    args: ["filename"]
}, ({filename}, context) => {
    context.config.setConfigFile(filename);
    if (!context.config.loadMasterConfig()) {
        logger.error("Unable to load master config.");
        process.exit(2);
    }
});

// === lists ===

registerGroup("lists", {
    label: "List modules",
    description: "Use these to list existing and loaded environments and behaviors",
    priority: 0
});

registerFeature("environments", {
    group: "lists",
    description: "List environment instances currently in the config file"
}, ({}, context) => {
    context.stop = true;
    let allenvs = context.config.environments;
    if (!allenvs || !Object.keys(allenvs).length) {
        console.log("No environments found.");
        return;
    }
    console.log("Environments ({NAME}):");
    for (let name in allenvs) {
        let thatenv = allenvs[name];
        console.log("  {" + name + "} - " + thatenv.type);
    }
});

registerFeature("behaviors", {
    group: "lists",
    description: "List behavior instances currently in the config file"
}, async ({}, context) => {
    context.stop = true;
    let allbes = context.config.behaviors;
    if (!allbes || !Object.keys(allbes).length) {
        console.log("No behaviors found.");
        return;
    }

    let display = {};
    let imi = {};
    for (let name in allbes) {
        let thatbe = allbes[name];
        if (!display[thatbe.type]) {
            display[thatbe.type] = [];
        }
        display[thatbe.type].push(thatbe);
        let be = await editConfig(context).getBehaviorInstance(name, thatbe.type);
        imi[thatbe.type] = be.isMultiInstanceable;
    }
    
    console.log("Behaviors (|NAME|):");
    for (let type in display) {
        if (!imi[type]) {
            console.log("  |" + type + "|");
        } else {
            let line = [];
            for (let be of display[type]) {
                line.push("|" + be.name + "|");
            }
            console.log("  " + type + ": " + line.join(", "));
        }
    }
});

function listParameters(mod) {
    if (!mod._trueParams.length) return;
    let required = [], optional = [], key = {};
    for (let {n, d} of mod._trueParams) {
        let e = [];
        if (mod.requiredEnvironments?.[n]) {
            e.push("[Env->" + mod.requiredEnvironments[n] + "]");
            key.env = "[Env] Required environment";
        }
        if (mod.requiredBehaviors?.[n]) {
            e.push("[Be->" + mod.requiredBehaviors[n] + "]");
            key.be = "[Be] Required behavior";
        }
        if (mod.optionalBehaviors?.[n]) {
            e.push("[OptBe->" + mod.optionalBehaviors[n] + "]");
            key.optbe = "[OptBe] Optional behavior";
        }
        if (mod._trueDefaults[n] !== undefined) {
            optional.push({n, d, e});
        } else {
            required.push({n, d, e});
        }
    }
    if (required.length) {
        console.log("\nRequired parameters:");
        for (let {n, d, e} of required) {
            console.log("  " + n + (e.length ? " " + e.join(" ") : "") + " - " + d);
        }
    }
    if (optional.length) {
        console.log("\nOptional parameters:");
        for (let {n, d, e} of optional) {
            console.log("  " + n + (e.length ? " " + e.join(" ") : "") + " - " + d);
        }
    }
    if (Object.keys(key).length) {
        console.log("\n" + Object.values(key).join(" "));
    }
}

registerFeature("environmentTypes", {
    group: "lists",
    description: "List available environment types or information about a type",
    args: ["type"],
    minArgs: 0
}, async ({type}, context) => {
    context.stop = true;
    if (type) {
        let env = await context.core.createEnvironment(type, "Dummy");
        console.log("=== " + env.type + " ===");
        console.log(env.description + "." || "!! Description missing !!");
        if (env.sharedModules.length) {
            console.log("\nShared modules:");
            for (let sm of env.sharedModules) {
                console.log("  " + sm);
            }
        }
        listParameters(env);
    } else {
        console.log("Existing environment types:")
        for (let type of await context.core.listEnvironmentTypes()) {
            let env;
            try {
                env = await context.core.createEnvironment(type, "Dummy");
            } catch (e) {
                continue;
            }
            let description = "!! Description missing !!";
            if (env && env.description) description = env.description;
            console.log(type + " - " + description);
        }
    }
});

registerFeature("behaviorTypes", {
    group: "lists",
    description: "List available behavior types or information about a type",
    args: ["type"],
    minArgs: 0
}, async ({type}, context) => {
    context.stop = true;
    if (type) {
        let be = await context.core.createBehavior(type, "Dummy");
        console.log("=== " + be.type + " ===");
        console.log(be.description + "." || "!! Description missing !!");
        console.log(be.isMultiInstanceable ? "Can have multiple instances" : "Single instance only");
        if (be.isCoreAccess) console.log("Requests core access");
        listParameters(be);
    } else {
        console.log("Existing behavior types (* means multi-instanceable):")
        for (let type of await context.core.listBehaviorTypes()) {
            let be;
            try {
                be = await context.core.createBehavior(type, "Dummy");
            } catch (e) {
                continue;
            }
            let description = "!! Description missing !!";
            if (be && be.description) description = be.description;
            console.log(type + (be?.isMultiInstanceable ? "*" : "") + " - " + description);
        }
    }
});

// === basic ===

registerGroup("basic", {
    label: "Add and remove modules",
    description: "Use these to manipulate the lists of environments and behaviors in the config file",
    priority: 1
});

registerFeature("addEnvironment", {
    group: "basic",
    description: "Add or replace an environment",
    args: ["name", "type"],
    minArgs: 1
}, ({name, type}, context) => {
    if (!type) type = name;
    editConfig(context).addEnvironment(name, type);
    let result = editConfig(context).addEnvironmentParameters(name, {required: true, missing: true});
    if (result == ConfigFail.TYPE_NOT_FOUND) {
        console.log("OK, but this type could not be found.");
    } else {
        console.log("OK.");
    }
});

registerFeature("addBehavior", {
    group: "basic",
    description: "Add or replace a behavior",
    args: ["name", "type"],
    minArgs: 1
}, ({name, type}, context) => {
    if (!type) type = name;
    editConfig(context).addBehavior(name, type);
    let result = editConfig(context).addBehaviorParameters(name, {required: true, missing: true});
    if (result == ConfigFail.TYPE_NOT_FOUND) {
        console.log("OK, but this type could not be found.");
    } else {
        console.log("OK.");
    }
});

registerFeature("insertBehavior", {
    group: "basic",
    description: "Insert a behavior before the one with the given BEFORE name or at the top of the list",
    args: ["name", "type", "before"],
    minArgs: 1
}, ({name, type, before}, context) => {
    if (!type) type = name;
    if (editConfig(context).insertBehaviorBefore(name, type, before)) {
        console.log("OK.");
    } else {
        console.log("There is no behavior with the given BEFORE name.");
    }
});

registerFeature("removeEnvironment", {
    group: "basic",
    description: "Remove an environment, including all associated parameters",
    args: ["name"]
}, ({name}, context) => {
    if (editConfig(context).removeEnvironment(name)) {
        console.log("OK.");
    } else {
        console.log("There is no such environment.");
    }
});

registerFeature("removeBehavior", {
    group: "basic",
    description: "Remove a behavior, including all associated parameters",
    args: ["name"]
}, ({name}, context) => {
    if (editConfig(context).removeBehavior(name)) {
        console.log("OK.");
    } else {
        console.log("There is no such behavior.");
    }
});

// === params ===

registerGroup("params", {
    label: "Add parameters to modules",
    description: "Use these to bootstrap the parameter maps of environments and behaviors in the config file",
    priority: 2
});

const paramsMode = {
    required: {required: true, missing: true},
    all: {required: false, missing: true},
    "overwrite-required": {required: true, missing: false},
    "overwrite-all": {required: false, missing: false}
};

registerFeature("addEnvironmentParams", {
    group: "params",
    description: "Add or replace environment parameters in the config file. MODE can be: required (missing mandatory parameters), all (all missing parameters, including optional), overwrite-required or overwrite-all (overwrites existing parameters)",
    args: ["name", "mode"],
    minArgs: 1
}, async ({name, mode}, context) => {
    if (!mode) mode = "required";
    if (!paramsMode[mode]) {
        console.log("MODE must be one of:", Object.keys(paramsMode).join(", "));
        return;
    }
    let result = await editConfig(context).addEnvironmentParameters(name, paramsMode[mode]);
    genericFeedback(result, "environment");
});

registerFeature("addBehaviorParams", {
    group: "params",
    description: "Add or replace behavior parameters in the config file. MODE can be: required (missing mandatory parameters), all (all missing parameters, including optional), overwrite-required or overwrite-all (overwrites existing parameters)",
    args: ["name", "mode"],
    minArgs: 1
}, async ({name, mode}, context) => {
    if (!mode) mode = "required";
    if (!paramsMode[mode]) {
        console.log("MODE must be one of:", Object.keys(paramsMode).join(", "));
        return;
    }
    let result = await editConfig(context).addBehaviorParameters(name, paramsMode[mode]);
    genericFeedback(result, "behavior");
});

// === comments ===

registerGroup("comments", {
    label: "Add and remove comments",
    description: "Use these to add or remove default explanatory comments in the config file",
    priority: 3
});

const commentsMode = {
    description: {header: true, params: false},
    params: {header: false, params: true},
    both: {header: true, params: true}
};

registerFeature("addEnvironmentComments", {
    group: "comments",
    description: "Add comments to existing environment entries in the config file. MODE can be: 'description' (just the environment description), 'params' (just the parameters) or 'both'. Add 'overwrite' at the end to replace existing comments",
    args: ["name", "mode", "overwrite"],
    minArgs: 1
}, async ({name, mode, overwrite}, context) => {
    if (!mode) mode = "both";
    if (!commentsMode[mode]) {
        console.log("MODE must be one of:", Object.keys(commentsMode).join(", "));
        return;
    }
    let options = Object.assign({unset: overwrite != "overwrite"}, commentsMode[mode]);
    let result = await editConfig(context).addEnvironmentComments(name, options);
    genericFeedback(result, "environment");
});

registerFeature("addBehaviorComments", {
    group: "comments",
    description: "Add comments to existing behavior entries in the config file. MODE can be: 'description' (just the behavior description), 'params' (just the parameters) or 'both'. Add 'overwrite' at the end to replace existing comments",
    args: ["name", "mode", "overwrite"],
    minArgs: 1
}, async ({name, mode, overwrite}, context) => {
    if (!mode) mode = "both";
    if (!commentsMode[mode]) {
        console.log("MODE must be one of:", Object.keys(commentsMode).join(", "));
        return;
    }
    let options = Object.assign({unset: overwrite != "overwrite"}, commentsMode[mode]);
    let result = await editConfig(context).addBehaviorComments(name, options);
    genericFeedback(result, "behavior");
});

registerFeature("removeEnvironmentComments", {
    group: "comments",
    description: "Remove comments from environment entries in the config file. MODE can be: 'description' (just the environment description), 'params' (just the parameters) or 'both'. Add 'always' to remove custom comments; by default only default comments are removed",
    args: ["name", "mode", "always"],
    minArgs: 1
}, async ({name, mode, always}, context) => {
    if (!mode) mode = "both";
    if (!commentsMode[mode]) {
        console.log("MODE must be one of:", Object.keys(commentsMode).join(", "));
        return;
    }
    let options = Object.assign({exact: always != "always"}, commentsMode[mode]);
    let result = await editConfig(context).removeEnvironmentComments(name, options);
    genericFeedback(result, "environment");
});

registerFeature("removeBehaviorComments", {
    group: "comments",
    description: "Remove comments from behavior entries in the config file. MODE can be: 'description' (just the behavior description), 'params' (just the parameters) or 'both'. Add 'always' to remove custom comments; by default only default comments are removed",
    args: ["name", "mode", "always"],
    minArgs: 1
}, async ({name, mode, always}, context) => {
    if (!mode) mode = "both";
    if (!commentsMode[mode]) {
        console.log("MODE must be one of:", Object.keys(commentsMode).join(", "));
        return;
    }
    let options = Object.assign({exact: always != "always"}, commentsMode[mode]);
    let result = await editConfig(context).removeBehaviorComments(name, options);
    genericFeedback(result, "behavior");
});


} //---