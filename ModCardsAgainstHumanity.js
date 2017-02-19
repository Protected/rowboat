/* Module: CardsAgainstHumanity -- Play CAH. */

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
        
        this.mod('Commands').registerCommand(this, 'cah', {
            description: "Plays cards against humanity",
            args: [],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (this.gameRunning) {
                ep.pub("There's a game running already!");
            } else {
                ep.pub("Starting a cah game.");
                this.gameRunning = true;
                this.gameData = {};
                this.gameData.askee = userid;
                let card = _.sample(this.blackCards);
                card.text = card.text.replace("_", "_____");
                this.gameData.card = card;
                this.gameData.players = [];
                this.gameData.phase = 0;
                this.gameData.pub = ep.pub;
                this.gameData.envName = env.name;
                this.gameData.playEvent = setTimeout(_cahPlayEvent, 60000);
                ep.pub("A new round of CaH has started! PM me with cahjoin to enter the round!! (60s)");
                ep.pub(card.text);
            }

            return true;
        });
        

        this.mod('Commands').registerCommand(this, 'cahjoin', {
            description: "Join a match of cards against humanity",
            args: [],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            if (this.gameRunning && this.gameData) {
                var finder = _.find(this.gameData.players, function (player) {
                    return player.nick.toLowerCase() == userid;
                });
                if (this.gameData.phase != 0) {
                    ep.pub("This is not the joining phase.");
                    return false;
                }
                if (finder) {
                    ep.pub("You already joined.");
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
                    ep.priv("Type: !cahplay <card number> to play. The black card is: " + this.gameData.card.text);
                    for (let i = 0; i < playerObj.cards.length; i++) {
                        ep.priv((i + 1) + ": " + playerObj.cards[i].text);
                    }
                }
            } else {
                ep.reply("There is no game going right now.");
            }

            return true;
        });


        this.mod('Commands').registerCommand(this, 'cahvote', {
            description: "Vote during a match of cards against humanity",
            args: ['cardNumber'],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            if (this.gameRunning && this.gameData) {
                var finder = _.find(this.gameData.players, function (player) {
                    return player.nick.toLowerCase() == userid.toLowerCase();
                });
                var choice = parseInt(args.cardNumber);
                if (isNaN(choice)) {
                    ep.priv("Bad value...");
                    return false;
                }
                if (this.gameData.phase != 1) {
                    ep.reply("This is not voting phase.");
                    return false;
                }
                if (!finder) {
                    ep.reply("You haven't joined this round.");
                    return false;
                } else {
                    if (finder.hasVoted) {
                        ep.reply("You have already voted.");
                        return false;
                    }
                    var chosenCards = this.gameData.chosenCards;

                    if (choice > 0 && choice <= chosenCards.length) {
                        var card = chosenCards[choice - 1];
                        card.votes += 1;
                        finder.hasVoted = true;
                        ep.priv("You've voted for " + (choice) + ": " + card.card.text);
                    } else {
                        ep.reply("Bad value...");
                        return;
                    }
                }

            } else {
                ep.reply("There is no game going right now.");
            }

            return true;
        });


        this.mod('Commands').registerCommand(this, 'cahplay', {
            description: "Play a card during a match of cards against humanity",
            args: ['cardNumber'],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            if (this.gameRunning && this.gameData) {
                var finder = _.find(this.gameData.players, function (player) {
                    return player.nick.toLowerCase() == userid.toLowerCase();
                });
                var choice = parseInt(args.cardNumber);
                if (isNaN(choice)) {
                    ep.reply("Bad value...");
                    return;
                }
                if (this.gameData.phase != 0) {
                    ep.reply("This is not playing phase.");
                    return;
                }
                if (!finder) {
                    ep.reply("You haven't joined yet, try !cahjoin");
                    return;
                } else {
                    if (choice > 0 && choice <= finder.cards.length) {
                        finder.chosenCard = finder.cards[choice - 1];
                        ep.priv("Wait for the voting round. You've chosen " + (choice) + ": " + finder.chosenCard.text);
                    } else {
                        ep.priv("Bad value...");
                        return;
                    }
                }

            } else {
                ep.reply("There is no game going right now.");
            }

            return true;
        });


        return true;
    };

}


module.exports = ModCardsAgainstHumanity;
