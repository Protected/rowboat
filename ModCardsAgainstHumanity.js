/* Module: Random -- Adds a command, "random", which outputs a random number. */

var Module = require('./Module.js');
var _ = require('lodash');
var jf = require('jsonfile');

class ModCardsAgainstHumanity extends Module {

    get RequiredModules() {
        return [
            'Commands'
        ];
    }

    constructor(name) {
        super('CardsAgainstHumanity', name);
        this.gameRunning = false;
        this.gameData = {};

        this.whiteCards = jf.readFileSync("cah_whiteCards.json");

        this.blackCards = jf.readFileSync("cah_blackCards.json");

    }
    

    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;

        let self = this;
        

        //Game phases
        
        function _cahPlayEvent() {

            self.gameData.phase = 1;

            self.gameData.chosenCards = _.map(self.gameData.players, player => {
                return {nick: player.nick, card: player.chosenCard, votes: 0};
            });

            _.each(self.gameData.players, function (player) {
                self.env(self.gameData.envName).msg(player.nick, "Time to vote. Use __cahvote <number>__");
                for (let chosenCardIdx in self.gameData.chosenCards) {
                    self.env(self.gameData.envName).msg(player.nick, (parseInt(chosenCardIdx) + 1) + ": " + self.gameData.chosenCards[chosenCardIdx].card.text);

                }
            });

            self.gameData.voteEvent = setTimeout(_cahVoteEvent, 60000);
        }

        function _cahVoteEvent() {
            self.gameData.phase = 2;
            var chosenCards = self.gameData.chosenCards;

            var votedCards = _.sortBy(chosenCards, function (card) {
                return card.votes * -1;
            });

            self.gameData.pub("Black card was: " + self.gameData.card.text);
            self.gameData.pub("Results by votes: ");

            for (var i = 0; i < votedCards.length; i++) {
                var vCard = votedCards[i];
                if (vCard.votes > 0) {
                    self.gameData.pub("Played by " + (self.env(self.gameData.envName).idToDisplayName(vCard.nick)) + " with " + vCard.votes + " votes: " + vCard.card.text);
                }
            }

            delete self.gameData;
        }


        //Register callbacks
        
        this.mod('Commands').registerCommand('cah', {
            description: "Plays cards against humanity",
            args: [],
            minArgs: 0
        }, (env, type, userid, command, args, handle, reply, pub) => {

            if (this.gameRunning) {
                pub("There's a game running already!");
            } else {
                pub("Starting a cah game.");
                this.gameRunning = true;
                this.gameData = {};
                this.gameData.askee = userid;
                let card = _.sample(this.blackCards);
                card.text = card.text.replace("_", "_____");
                this.gameData.card = card;
                this.gameData.players = [];
                this.gameData.phase = 0;
                this.gameData.pub = pub;
                this.gameData.envName = env.name;
                this.gameData.playEvent = setTimeout(_cahPlayEvent, 60000);
                pub("A new round of CaH has started! PM me with cahjoin to enter the round!! (60s)");
                pub(card.text);
            }

            return true;
        });
        

        this.mod('Commands').registerCommand('cahjoin', {
            description: "Join a match of cards against humanity",
            args: [],
            minArgs: 0
        }, (env, type, userid, command, args, handle, reply, pub, priv) => {
            if (this.gameRunning && this.gameData) {
                var finder = _.find(this.gameData.players, function (player) {
                    return player.nick.toLowerCase() == userid;
                });
                if (this.gameData.phase != 0) {
                    pub("This is not the joining phase.");
                    return false;
                }
                if (finder) {
                    pub("You already joined.");
                    return false;
                } else {
                    var playerObj = {};
                    playerObj.nick = userid;
                    playerObj.cards = [];
                    for (let i = 0; i < 5;) {
                        var r = _(this.whiteCards).filter(card=>!_(playerObj.cards).find(playerCard=>playerCard.id == card.id)).sample();
                        if (r) {
                            playerObj.cards.push(r);
                            i++;
                        }
                    }
                    this.gameData.players.push(playerObj);
                    priv("Type: !cahplay <card number> to play. The black card is: " + this.gameData.card.text);
                    for (let i = 0; i < playerObj.cards.length; i++) {
                        priv((i + 1) + ": " + playerObj.cards[i].text);
                    }
                }
            } else {
                reply("There is no game going right now.");
            }

            return true;
        });


        this.mod('Commands').registerCommand('cahvote', {
            description: "Vote during a match of cards against humanity",
            args: ['cardNumber'],
            minArgs: 0
        }, (env, type, userid, command, args, handle, reply, pub, priv) => {
            if (this.gameRunning && this.gameData) {
                var finder = _.find(this.gameData.players, function (player) {
                    return player.nick.toLowerCase() == userid.toLowerCase();
                });
                var choice = parseInt(args.cardNumber);
                if (isNaN(choice)) {
                    priv("Bad value...");
                    return false;
                }
                if (this.gameData.phase != 1) {
                    reply("This is not voting phase.");
                    return false;
                }
                if (!finder) {
                    reply("You haven't joined this round.");
                    return false;
                } else {
                    if (finder.hasVoted) {
                        reply("You have already voted.");
                        return false;
                    }
                    var chosenCards = this.gameData.chosenCards;

                    if (choice > 0 && choice <= chosenCards.length) {
                        var card = chosenCards[choice - 1];
                        card.votes += 1;
                        finder.hasVoted = true;
                        priv("You've voted for " + (choice) + ": " + card.card.text);
                    } else {
                        reply("Bad value...");
                        return;
                    }
                }

            } else {
                reply("There is no game going right now.");
            }

            return true;
        });


        this.mod('Commands').registerCommand('cahplay', {
            description: "Play a card during a match of cards against humanity",
            args: ['cardNumber'],
            minArgs: 0
        }, (env, type, userid, command, args, handle, reply, pub, priv) => {
            if (this.gameRunning && this.gameData) {
                var finder = _.find(this.gameData.players, function (player) {
                    return player.nick.toLowerCase() == userid.toLowerCase();
                });
                var choice = parseInt(args.cardNumber);
                if (isNaN(choice)) {
                    reply("Bad value...");
                    return;
                }
                if (this.gameData.phase != 0) {
                    reply("This is not playing phase.");
                    return;
                }
                if (!finder) {
                    reply("You haven't joined yet, try !cahjoin");
                    return;
                } else {
                    if (choice > 0 && choice <= finder.cards.length) {
                        finder.chosenCard = finder.cards[choice - 1];
                        priv("Wait for the voting round. You've chosen " + (choice) + ": " + finder.chosenCard.text);
                    } else {
                        priv("Bad value...");
                        return;
                    }
                }

            } else {
                reply("There is no game going right now.");
            }

            return true;
        });


        return true;
    };

}


module.exports = ModCardsAgainstHumanity;
