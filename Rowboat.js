var irc = require('irc');
var _ = require('underscore');
var jf = require('jsonfile');

var argv = require('yargs')
          .default('server','irc.rizon.net')
          .default('nick','Rowboat')
          .default('channel','#discworld')
          .default('password',null)
          .argv
		  ;


var client = new irc.Client(argv.server, argv.nick, {
    channels: [argv.channel],
	userName: 'myshelter',
	realName: 'Not a pun, just a misunderstanding.',
	floodProtection: true,
	floodProtectionDelay: 500,
	stripColors: false,
	password: argv.password
});

var callbackList = {};

var PAObj;


//Modules

var modules = [
	{
		name: "Discord.js",
		exp: undefined,
	}
];

function loadModules() {
	_.each(modules, function(module) {
		try {
			if (module.exp) {
				module.exp.onReassemble();
            }
			module.exp = requireUncached('./' + module.name);
			module.exp.setMain(PAObj);
			callbackList[module.name] = module.exp.messageCallback;
		} catch(ex) {
			console.log("[ERR] Loading module '" + module.name + "': " + ex);
		}
	});
}


//Public Access Object

PAObj = {
	client: client
};


loadModules();


client.addListener('error', function(message) {
    console.log('error: ', message);
});


client.addListener('message', function (from, to, message, messageObj) {
    var messageArr = message.split(" ");
    var commandStr = messageArr[0].substring(1);

	_.each(modules, function(module) {
		if (callbackList[module.name]) {
			callbackList[module.name](from, to, message, messageObj);
		}
	});
});


//Reload

function requireUncached(module) {
    delete require.cache[require.resolve(module)];
    return require(module);
}
