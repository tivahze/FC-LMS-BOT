require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits
} = require('discord.js');

const fs = require('fs');
const cron = require('node-cron');

// ==========================================
// CONFIGURATION
// ==========================================

const CLIENT_ID = '1543310434105426082';
const GUILD_ID = '1022252307502596096';

const SALON_PRESENTATION_ID = '1163077369121222746';
const SALON_PRESENCE_ID = '1293603511078223962';

const FICHIER_PRESENCES = './presences.json';

// ==========================================
// CLIENT DISCORD
// ==========================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ==========================================
// POSTES
// ==========================================

const ORDRE_POSTES = [
    'GK',
    'DD',
    'DC',
    'DCD',
    'DCG',
    'DG',
    'MDC',
    'MC',
    'MOC',
    'MD',
    'MG',
    'AD',
    'AG',
    'BU',
    'ATD',
    'ATG'
];

// ==========================================
// JOURS
// ==========================================

const JOURS = [
    'lundi',
    'mardi',
    'mercredi',
    'jeudi',
    'vendredi',
    'samedi',
    'dimanche'
];

const JOURS_COURTS = {
    lundi: 'LUNDI',
    mardi: 'MARDI',
    mercredi: 'MERCREDI',
    jeudi: 'JEUDI',
    vendredi: 'VENDREDI',
    samedi: 'SAMEDI',
    dimanche: 'DIMANCHE'
};

// ==========================================
// JOUEURS
// ==========================================

let joueurs = [];

// ==========================================
// PRESENCES
// ==========================================

let presences = {};

let messagePresenceId = null;

// ==========================================
// CREER SEMAINE VIDE
// ==========================================

function creerSemaineVide() {

    const semaine = {};

    for (const jour of JOURS) {
        semaine[jour] = {};
    }

    return semaine;
}

// ==========================================
// CHARGER PRESENCES
// ==========================================

function chargerPresences() {

    try {

        if (!fs.existsSync(FICHIER_PRESENCES)) {

            presences = creerSemaineVide();

            sauvegarderPresences();

            console.log('✅ Nouveau fichier presences.json créé.');

            return;
        }

        const contenu = fs.readFileSync(
            FICHIER_PRESENCES,
            'utf8'
        );

        presences = JSON.parse(contenu);

        for (const jour of JOURS) {

            if (!presences[jour]) {
                presences[jour] = {};
            }
        }

        console.log('✅ Présences chargées.');

    } catch (error) {

        console.error(
            '❌ Impossible de charger les présences :'
        );

        console.error(error);

        presences = creerSemaineVide();
    }
}

// ==========================================
// SAUVEGARDER PRESENCES
// ==========================================

function sauvegarderPresences() {

    try {

        fs.writeFileSync(
            FICHIER_PRESENCES,
            JSON.stringify(
                presences,
                null,
                2
            )
        );

    } catch (error) {

        console.error(
            '❌ Erreur sauvegarde présences :'
        );

        console.error(error);
    }
}

// ==========================================
// EXTRAIRE POSTES
// ==========================================

function extrairePostes(texte) {

    if (!texte) return [];

    let p = texte
        .toUpperCase()
        .trim();

    // ==================================
    // PISTONS
    // ==================================

    p = p
        .replace(/PISTON\s+DROIT/g, ' MD ')
        .replace(/PISTON\s+GAUCHE/g, ' MG ')
        .replace(/PISTON\s+D\b/g, ' MD ')
        .replace(/PISTON\s+G\b/g, ' MG ');

    if (p === 'PISTON') {
        return ['MD', 'MG'];
    }

    // ==================================
    // SEPARATEURS
    // ==================================

    p = p.replace(/\bET\b/g, ' ');

    p = p.replace(
        /[\/,;|+]+/g,
        ' '
    );

    const morceaux = p
        .split(/\s+/)
        .filter(Boolean);

    const postes = [];

    for (const morceau of morceaux) {

        if (ORDRE_POSTES.includes(morceau)) {

            if (!postes.includes(morceau)) {
                postes.push(morceau);
            }
        }
    }

    return postes;
}

// ==========================================
// ANALYSER PRESENTATION
// ==========================================

function analyserPresentation(message) {

    let texte = message.content
        .replace(/\r/g, '')
        .replace(/[*_]/g, '')
        .trim();

    if (!texte) return null;

    const lignes = texte
        .split('\n')
        .map(ligne =>
            ligne
                .trim()
                .replace(/^>\s*/, '')
        )
        .filter(ligne =>
            ligne.length > 0
        );

    let pseudo = null;
    let principal = null;
    let secondaire = 'Aucun';

    for (const ligne of lignes) {

        // ==================================
        // PSEUDO
        // ==================================

        if (!pseudo) {

            let match = ligne.match(
                /🆔\s*(.+)/i
            );

            if (!match) {
                match = ligne.match(
                    /Pseudo\s*EA\s*\/\s*PSN\s*\/\s*Xbox\s*:\s*(.+)/i
                );
            }

            if (!match) {
                match = ligne.match(
                    /Pseudo\s*EA\s*:\s*(.+)/i
                );
            }

            if (!match) {
                match = ligne.match(
                    /Pseudo\s*:\s*(.+)/i
                );
            }

            if (match) {
                pseudo = match[1].trim();
            }
        }

        // ==================================
        // POSTE PRINCIPAL
        // ==================================

        if (!principal) {

            let match = ligne.match(
                /Poste\s+principal\s*:\s*(.+)/i
            );

            if (!match) {
                match = ligne.match(
                    /^Poste\s*:\s*(.+)/i
                );
            }

            if (match) {

                principal = match[1]
                    .trim()
                    .toUpperCase();
            }
        }

        // ==================================
        // POSTE SECONDAIRE
        // ==================================

        let matchSecondaire = ligne.match(
            /Poste\s*\(s\)\s*secondaire\s*\(s\)\s*:\s*(.+)/i
        );

        if (!matchSecondaire) {

            matchSecondaire = ligne.match(
                /Poste\s+secondaire\s*:\s*(.+)/i
            );
        }

        if (matchSecondaire) {

            secondaire = matchSecondaire[1]
                .trim()
                .toUpperCase();
        }
    }

    // ==================================
    // VERIFICATION
    // ==================================

    if (!pseudo || !principal) {
        return null;
    }

    if (
        pseudo.toLowerCase().includes('pseudo ea') ||
        principal.toLowerCase().includes('poste principal')
    ) {
        return null;
    }

    return {
        id: message.author.id,
        pseudo,
        principal,
        secondaire,
        messageId: message.id
    };
}

// ==========================================
// SCANNER PRESENTATIONS
// ==========================================

async function scannerPresentations(guild) {

    if (!guild) {
        console.log('❌ Serveur introuvable.');
        return;
    }

    console.log(
        '🔎 Recherche du salon de présentation...'
    );

    const salon = guild.channels.cache.get(
        SALON_PRESENTATION_ID
    );

    if (!salon) {

        console.log(
            '❌ Salon de présentation introuvable.'
        );

        return;
    }

    console.log(
        `✅ Salon trouvé : #${salon.name}`
    );

    joueurs = [];

    let dernierMessageId = null;

    while (true) {

        const options = {
            limit: 100
        };

        if (dernierMessageId) {
            options.before = dernierMessageId;
        }

        const messages =
            await salon.messages.fetch(options);

        if (messages.size === 0) {
            break;
        }

        for (const message of messages.values()) {

            const joueur =
                analyserPresentation(message);

            if (!joueur) {
                continue;
            }

            const existe =
                joueurs.find(
                    j => j.id === joueur.id
                );

            if (!existe) {
                joueurs.push(joueur);
            }
        }

        dernierMessageId =
            messages.last().id;

        if (messages.size < 100) {
            break;
        }
    }

    console.log(
        `👥 ${joueurs.length} joueur(s) trouvé(s).`
    );
}

// ==========================================
// HEURE ACTUELLE
// ==========================================

function heureActuelle() {

    return new Date().getHours();
}

// ==========================================
// JOUR ACTUEL
// ==========================================

function obtenirJourActuel() {

    const index =
        new Date().getDay();

    const conversion = {
        0: 'dimanche',
        1: 'lundi',
        2: 'mardi',
        3: 'mercredi',
        4: 'jeudi',
        5: 'vendredi',
        6: 'samedi'
    };

    return conversion[index];
}

// ==========================================
// JOUR BLOQUE
// ==========================================

function jourBloque(jour) {

    const aujourdHui =
        obtenirJourActuel();

    if (jour !== aujourdHui) {
        return false;
    }

    return heureActuelle() >= 19;
}

// ==========================================
// ENREGISTRER PRESENCE
// ==========================================

function enregistrerPresence(
    userId,
    jours,
    statut
) {

    const aujourdHui =
        obtenirJourActuel();

    const refuses = [];

    for (const jour of jours) {

        if (!JOURS.includes(jour)) {
            continue;
        }

        if (
            jour === aujourdHui &&
            jourBloque(jour)
        ) {

            refuses.push(jour);

            continue;
        }

        if (!presences[jour]) {
            presences[jour] = {};
        }

        presences[jour][userId] = {
            userId,
            statut,
            updatedAt:
                new Date().toISOString()
        };
    }

    sauvegarderPresences();

    return refuses;
}

// ==========================================
// EMBED GENERAL PRESENCES
// ==========================================

async function construireEmbedPresences() {

    let description = '';

    description +=
        '🟢 **/present** → indique tes jours présents.\n';

    description +=
        '🔴 **/absent** → indique tes jours absents.\n\n';

    description +=
        '💡 Tu peux modifier tes disponibilités sans modifier les autres jours.\n\n';

    description +=
        '⏰ **Après 19h00, le jour même est verrouillé.**\n\n';

    description +=
        '━━━━━━━━━━━━━━━━━━━━\n\n';

    for (const jour of JOURS) {

        const donnees =
            presences[jour] || {};

        const presents =
            Object.values(donnees)
                .filter(
                    joueur =>
                        joueur.statut ===
                        'present'
                );

        const absents =
            Object.values(donnees)
                .filter(
                    joueur =>
                        joueur.statut ===
                        'absent'
                );

        description +=
            `## 📅 ${JOURS_COURTS[jour]}\n\n`;

        description +=
            `🟢 **PRÉSENTS — ${presents.length}**\n`;

        if (presents.length === 0) {

            description +=
                '• Aucun joueur\n';

        } else {

            for (const joueur of presents) {

                description +=
                    `• <@${joueur.userId}>\n`;
            }
        }

        description += '\n';

        description +=
            `🔴 **ABSENTS — ${absents.length}**\n`;

        if (absents.length === 0) {

            description +=
                '• Aucun joueur\n';

        } else {

            for (const joueur of absents) {

                description +=
                    `• <@${joueur.userId}>\n`;
            }
        }

        description +=
            '\n━━━━━━━━━━━━━━━━━━━━\n\n';
    }

    return new EmbedBuilder()
        .setTitle(
            '⚽ FC LMS • PRÉSENCES'
        )
        .setDescription(description)
        .setColor(0x7b2cff)
        .setTimestamp()
        .setFooter({
            text:
                'FC LMS • Présences de la semaine'
        });
}

// ==========================================
// BOUTONS
// ==========================================

function construireBoutons() {

    const present =
        new ButtonBuilder()
            .setCustomId(
                'presence_present'
            )
            .setLabel(
                '🟢 Présent'
            )
            .setStyle(
                ButtonStyle.Success
            );

    const absent =
        new ButtonBuilder()
            .setCustomId(
                'presence_absent'
            )
            .setLabel(
                '🔴 Absent'
            )
            .setStyle(
                ButtonStyle.Danger
            );

    return new ActionRowBuilder()
        .addComponents(
            present,
            absent
        );
}

// ==========================================
// MENU JOURS
// ==========================================

function construireMenuJours(statut) {

    const options = [];

    for (const jour of JOURS) {

        options.push(
            new StringSelectMenuOptionBuilder()
                .setLabel(
                    JOURS_COURTS[jour]
                )
                .setValue(jour)
                .setDescription(
                    jourBloque(jour)
                        ? '🔒 Jour verrouillé après 19h'
                        : `Choisir ${jour}`
                )
        );
    }

    return new StringSelectMenuBuilder()
        .setCustomId(
            `choix_jours_${statut}`
        )
        .setPlaceholder(
            statut === 'present'
                ? '🟢 Choisis tes jours présents'
                : '🔴 Choisis tes jours absents'
        )
        .setMinValues(1)
        .setMaxValues(7)
        .addOptions(options);
}

// ==========================================
// ACTUALISER MESSAGE PRESENCE
// ==========================================

async function actualiserMessagePresences() {

    try {

        const guild =
            await client.guilds.fetch(
                GUILD_ID
            );

        const salon =
            await guild.channels.fetch(
                SALON_PRESENCE_ID
            );

        if (!salon) {

            console.log(
                '❌ Salon des présences introuvable.'
            );

            return;
        }

        const embed =
            await construireEmbedPresences();

        const boutons =
            construireBoutons();

        let message = null;

        if (messagePresenceId) {

            try {

                message =
                    await salon.messages.fetch(
                        messagePresenceId
                    );

            } catch {
                message = null;
            }
        }

        if (!message) {

            const messages =
                await salon.messages.fetch({
                    limit: 20
                });

            message =
                messages.find(
                    m =>
                        m.author.id ===
                        client.user.id
                );
        }

        if (message) {

            await message.edit({
                content: '@everyone',
                embeds: [embed],
                components: [boutons]
            });

            messagePresenceId =
                message.id;

            return;
        }

        const nouveauMessage =
            await salon.send({
                content: '@everyone',
                embeds: [embed],
                components: [boutons]
            });

        messagePresenceId =
            nouveauMessage.id;

        console.log(
            '✅ Message de présence créé.'
        );

    } catch (error) {

        console.error(
            '❌ Erreur actualisation présences :'
        );

        console.error(error);
    }
}

// ==========================================
// OUVRIR CHOIX JOURS
// ==========================================

async function ouvrirChoixJours(
    interaction,
    statut
) {

    const menu =
        construireMenuJours(statut);

    const row =
        new ActionRowBuilder()
            .addComponents(menu);

    await interaction.reply({
        content:
            statut === 'present'
                ? '🟢 **Choisis les jours où tu seras présent :**'
                : '🔴 **Choisis les jours où tu seras absent :**',
        components: [row],
        ephemeral: true
    });
}

// ==========================================
// CONSTRUIRE PRESENCES PAR POSTES
// ==========================================

function joueursParPostes(
    joueursPresence,
    statut
) {

    const result = {};

    for (const poste of ORDRE_POSTES) {
        result[poste] = [];
    }

    for (const presence of joueursPresence) {

        const joueur =
            joueurs.find(
                j =>
                    j.id === presence.userId
            );

        if (!joueur) {
            continue;
        }

        const postes =
            statut === 'principal'
                ? extrairePostes(
                    joueur.principal
                )
                : extrairePostes(
                    joueur.secondaire
                );

        for (const poste of postes) {

            if (!result[poste]) {
                result[poste] = [];
            }

            if (
                !result[poste].some(
                    j =>
                        j.id === joueur.id
                )
            ) {

                result[poste].push(joueur);
            }
        }
    }

    return result;
}

// ==========================================
// CONSTRUIRE /PRESENCES
// ==========================================

async function construireEmbedAdminPresences() {

    let description = '';

    description +=
        '📊 **JOUEURS PRÉSENTS DE LA SEMAINE**\n\n';

    description +=
        '━━━━━━━━━━━━━━━━━━━━\n\n';

    for (const jour of JOURS) {

        const donnees =
            presences[jour] || {};

        const presents =
            Object.values(donnees)
                .filter(
                    joueur =>
                        joueur.statut ===
                        'present'
                );

        description +=
            `# 📅 ${JOURS_COURTS[jour]}\n\n`;

        if (presents.length === 0) {

            description +=
                '🟢 Aucun joueur présent.\n\n';

            description +=
                '━━━━━━━━━━━━━━━━━━━━\n\n';

            continue;
        }

        // ==================================
        // PRINCIPAUX
        // ==================================

        const principaux =
            joueursParPostes(
                presents,
                'principal'
            );

        description +=
            '## 🎽 POSTES PRINCIPAUX\n\n';

        let nombrePrincipal = 0;

        for (const poste of ORDRE_POSTES) {

            if (
                !principaux[poste] ||
                principaux[poste].length === 0
            ) {
                continue;
            }

            nombrePrincipal +=
                principaux[poste].length;

            description +=
                `**${poste} — ${principaux[poste].length}**\n`;

            description +=
                principaux[poste]
                    .map(
                        joueur =>
                            `• ${joueur.pseudo}`
                    )
                    .join('\n');

            description += '\n\n';
        }

        if (nombrePrincipal === 0) {

            description +=
                '• Aucun poste principal trouvé.\n\n';
        }

        // ==================================
        // SECONDAIRES
        // ==================================

        const secondaires =
            joueursParPostes(
                presents,
                'secondaire'
            );

        description +=
            '## 🔄 POSTES SECONDAIRES\n\n';

        let nombreSecondaire = 0;

        for (const poste of ORDRE_POSTES) {

            if (
                !secondaires[poste] ||
                secondaires[poste].length === 0
            ) {
                continue;
            }

            nombreSecondaire +=
                secondaires[poste].length;

            description +=
                `**${poste} — ${secondaires[poste].length}**\n`;

            description +=
                secondaires[poste]
                    .map(
                        joueur =>
                            `• ${joueur.pseudo}`
                    )
                    .join('\n');

            description += '\n\n';
        }

        if (nombreSecondaire === 0) {

            description +=
                '• Aucun poste secondaire trouvé.\n\n';
        }

        description +=
            `👥 **TOTAL PRÉSENTS : ${presents.length} joueur(s)**\n\n`;

        description +=
            '━━━━━━━━━━━━━━━━━━━━\n\n';
    }

    return new EmbedBuilder()
        .setTitle(
            '⚽ FC LMS • PRÉSENCES PAR POSTES'
        )
        .setDescription(description)
        .setColor(0x7b2cff)
        .setTimestamp()
        .setFooter({
            text:
                'FC LMS • Réservé aux administrateurs'
        });
}

// ==========================================
// COMMANDES
// ==========================================

const commands = [

    new SlashCommandBuilder()
        .setName('effectif')
        .setDescription(
            'Affiche l’effectif du FC LMS'
        ),

    new SlashCommandBuilder()
        .setName('present')
        .setDescription(
            'Indique les jours où tu es présent'
        ),

    new SlashCommandBuilder()
        .setName('absent')
        .setDescription(
            'Indique les jours où tu es absent'
        ),

    new SlashCommandBuilder()
        .setName('presences')
        .setDescription(
            'Affiche les joueurs présents par postes'
        )
        .setDefaultMemberPermissions(
            PermissionFlagsBits.Administrator
        )

].map(
    command =>
        command.toJSON()
);

// ==========================================
// ENREGISTRER COMMANDES
// ==========================================

async function enregistrerCommandes() {

    const rest =
        new REST({
            version: '10'
        }).setToken(
            process.env.TOKEN
        );

    try {

        console.log(
            'Enregistrement des commandes...'
        );

        await rest.put(
            Routes.applicationGuildCommands(
                CLIENT_ID,
                GUILD_ID
            ),
            {
                body: commands
            }
        );

        console.log(
            '✅ Commandes enregistrées !'
        );

    } catch (error) {

        console.error(
            '❌ Erreur commandes :'
        );

        console.error(error);
    }
}

// ==========================================
// BOT PRET
// ==========================================

client.once(
    'clientReady',
    async () => {

        console.log(
            `✅ ${client.user.tag} est connecté !`
        );

        console.log(
            '📋 Serveurs auxquels le bot a accès :'
        );

        for (
            const [id, guild]
            of client.guilds.cache
        ) {

            console.log(
                `➡️ ${guild.name} | ID : ${id}`
            );
        }

        chargerPresences();

        await enregistrerCommandes();

        try {

            const guild =
                await client.guilds.fetch(
                    GUILD_ID
                );

            console.log(
                `✅ Serveur trouvé : ${guild.name}`
            );

            await scannerPresentations(
                guild
            );

            await actualiserMessagePresences();

        } catch (error) {

            console.error(
                '❌ Erreur initialisation :'
            );

            console.error(error);
        }
    }
);

// ==========================================
// NOUVEAU MESSAGE PRESENTATION
// ==========================================

client.on(
    'messageCreate',
    async message => {

        if (message.author.bot) {
            return;
        }

        if (
            message.channel.id !==
            SALON_PRESENTATION_ID
        ) {
            return;
        }

        const joueur =
            analyserPresentation(message);

        if (!joueur) {
            return;
        }

        const index =
            joueurs.findIndex(
                j =>
                    j.id ===
                    joueur.id
            );

        if (index >= 0) {

            joueurs[index] =
                joueur;

        } else {

            joueurs.push(
                joueur
            );
        }

        console.log(
            `👤 ${joueur.pseudo} → ${joueur.principal} / ${joueur.secondaire}`
        );
    }
);

// ==========================================
// INTERACTIONS
// ==========================================

client.on(
    'interactionCreate',
    async interaction => {

        try {

            // ==================================
            // COMMANDES SLASH
            // ==================================

            if (
                interaction.isChatInputCommand()
            ) {

                // ==================================
                // EFFECTIF
                // ==================================

                if (
                    interaction.commandName ===
                    'effectif'
                ) {

                    await interaction.deferReply();

                    const guild =
                        await client.guilds.fetch(
                            GUILD_ID
                        );

                    await scannerPresentations(
                        guild
                    );

                    if (
                        joueurs.length === 0
                    ) {

                        await interaction.editReply(
                            '❌ Aucun joueur trouvé dans le salon de présentation.'
                        );

                        return;
                    }

                    const principaux = {};
                    const secondaires = {};

                    for (
                        const joueur
                        of joueurs
                    ) {

                        const postes =
                            extrairePostes(
                                joueur.principal
                            );

                        for (
                            const poste
                            of postes
                        ) {

                            if (
                                !principaux[poste]
                            ) {
                                principaux[poste] = [];
                            }

                            if (
                                !principaux[poste].some(
                                    j =>
                                        j.id ===
                                        joueur.id
                                )
                            ) {

                                principaux[poste].push(
                                    joueur
                                );
                            }
                        }
                    }

                    for (
                        const joueur
                        of joueurs
                    ) {

                        const postes =
                            extrairePostes(
                                joueur.secondaire
                            );

                        for (
                            const poste
                            of postes
                        ) {

                            if (
                                !secondaires[poste]
                            ) {
                                secondaires[poste] = [];
                            }

                            if (
                                !secondaires[poste].some(
                                    j =>
                                        j.id ===
                                        joueur.id
                                )
                            ) {

                                secondaires[poste].push(
                                    joueur
                                );
                            }
                        }
                    }

                    let description =
                        '## 🎽 POSTES PRINCIPAUX\n\n';

                    for (
                        const poste
                        of ORDRE_POSTES
                    ) {

                        if (
                            !principaux[poste]
                        ) {
                            continue;
                        }

                        description +=
                            `**${poste} — ${principaux[poste].length}**\n`;

                        description +=
                            principaux[poste]
                                .map(
                                    joueur =>
                                        `• ${joueur.pseudo}`
                                )
                                .join('\n');

                        description += '\n\n';
                    }

                    description +=
                        '## 🔄 POSTES SECONDAIRES\n\n';

                    for (
                        const poste
                        of ORDRE_POSTES
                    ) {

                        if (
                            !secondaires[poste]
                        ) {
                            continue;
                        }

                        description +=
                            `**${poste} — ${secondaires[poste].length}**\n`;

                        description +=
                            secondaires[poste]
                                .map(
                                    joueur =>
                                        `• ${joueur.pseudo}`
                                )
                                .join('\n');

                        description += '\n\n';
                    }

                    description +=
                        `👥 **TOTAL : ${joueurs.length} joueur(s)**`;

                    const embed =
                        new EmbedBuilder()
                            .setTitle(
                                '⚽ EFFECTIF FC LMS'
                            )
                            .setDescription(
                                description
                            )
                            .setColor(
                                0x7b2cff
                            )
                            .setTimestamp()
                            .setFooter({
                                text:
                                    'FC LMS • Effectif'
                            });

                    await interaction.editReply({
                        embeds: [embed]
                    });

                    return;
                }

                // ==================================
                // PRESENT
                // ==================================

                if (
                    interaction.commandName ===
                    'present'
                ) {

                    await ouvrirChoixJours(
                        interaction,
                        'present'
                    );

                    return;
                }

                // ==================================
                // ABSENT
                // ==================================

                if (
                    interaction.commandName ===
                    'absent'
                ) {

                    await ouvrirChoixJours(
                        interaction,
                        'absent'
                    );

                    return;
                }

                // ==================================
                // PRESENCES ADMIN
                // ==================================

                if (
                    interaction.commandName ===
                    'presences'
                ) {

                    if (
                        !interaction.memberPermissions
                            .has(
                                PermissionFlagsBits.Administrator
                            )
                    ) {

                        await interaction.reply({
                            content:
                                '❌ Cette commande est réservée aux administrateurs.',
                            ephemeral: true
                        });

                        return;
                    }

                    await interaction.deferReply({
                        ephemeral: true
                    });

                    const guild =
                        await client.guilds.fetch(
                            GUILD_ID
                        );

                    await scannerPresentations(
                        guild
                    );

                    const embed =
                        await construireEmbedAdminPresences();

                    await interaction.editReply({
                        embeds: [embed]
                    });

                    return;
                }
            }

            // ==================================
            // BOUTONS
            // ==================================

            if (
                interaction.isButton()
            ) {

                if (
                    interaction.customId ===
                    'presence_present'
                ) {

                    await ouvrirChoixJours(
                        interaction,
                        'present'
                    );

                    return;
                }

                if (
                    interaction.customId ===
                    'presence_absent'
                ) {

                    await ouvrirChoixJours(
                        interaction,
                        'absent'
                    );

                    return;
                }
            }

            // ==================================
            // MENU JOURS
            // ==================================

            if (
                interaction.isStringSelectMenu()
            ) {

                if (
                    !interaction.customId.startsWith(
                        'choix_jours_'
                    )
                ) {
                    return;
                }

                const statut =
                    interaction.customId.replace(
                        'choix_jours_',
                        ''
                    );

                const joursChoisis =
                    interaction.values;

                const refuses =
                    enregistrerPresence(
                        interaction.user.id,
                        joursChoisis,
                        statut
                    );

                await actualiserMessagePresences();

                let texte =
                    statut === 'present'
                        ? '🟢 **Disponibilité enregistrée !**'
                        : '🔴 **Absence enregistrée !**';

                texte +=
                    `\n\n📅 Jours sélectionnés : ${joursChoisis
                        .map(
                            jour =>
                                `**${JOURS_COURTS[jour]}**`
                        )
                        .join(', ')}`;

                if (
                    refuses.length > 0
                ) {

                    texte +=
                        `\n\n⛔ Impossible de modifier : ${refuses
                            .map(
                                jour =>
                                    `**${JOURS_COURTS[jour]}**`
                            )
                            .join(', ')}.`;

                    texte +=
                        '\nLe jour même est verrouillé à partir de 19h.';
                }

                await interaction.update({
                    content: texte,
                    components: []
                });

                return;
            }

        } catch (error) {

            console.error(
                '❌ ERREUR INTERACTION :'
            );

            console.error(error);

            try {

                if (
                    interaction.replied ||
                    interaction.deferred
                ) {

                    await interaction.followUp({
                        content:
                            '❌ Une erreur est survenue.',
                        ephemeral: true
                    });

                } else {

                    await interaction.reply({
                        content:
                            '❌ Une erreur est survenue.',
                        ephemeral: true
                    });
                }

            } catch {}
        }
    }
);

// ==========================================
// NOUVELLE SEMAINE
// LUNDI 00H00
// ==========================================

cron.schedule(
    '0 0 * * 1',
    async () => {

        console.log(
            '🔄 Nouvelle semaine : remise à zéro des présences...'
        );

        presences =
            creerSemaineVide();

        sauvegarderPresences();

        await actualiserMessagePresences();

        console.log(
            '✅ Nouvelle semaine créée.'
        );

    },
    {
        timezone:
            'Europe/Paris'
    }
);

// ==========================================
// ACTUALISATION AUTOMATIQUE
// TOUTES LES 5 MINUTES
// ==========================================

cron.schedule(
    '*/5 * * * *',
    async () => {

        await actualiserMessagePresences();

    },
    {
        timezone:
            'Europe/Paris'
    }
);

// ==========================================
// CONNEXION
// ==========================================

client.login(
    process.env.TOKEN
);