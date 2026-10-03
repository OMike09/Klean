// ============================================================
// KLEAN-SERVICES CI — Grande base des MÉTIERS de Côte d'Ivoire
// Structure : MÉTIER → SOUS-CATÉGORIES → SERVICES → TÂCHES
// Insérée une seule fois (les éléments déjà présents sont conservés).
// Tout reste modifiable ensuite depuis le tableau de bord.
// ============================================================
// Format : { m:'Métier', i:'icône', sc:[{ n:'Sous-catégorie', sv:[{ n:'Service', k:'mots,clés', t:['Tâche',...] }] }] }

const METIERS = [
{ m:'Nettoyage & entretien', i:'🧹', sc:[
  { n:'Maison', sv:[
    { n:'Ménage à domicile', k:'menage,nettoyage,maison,femme de menage,proprete', t:['Nettoyage complet de la maison','Nettoyage de la cuisine','Nettoyage des sanitaires','Dépoussiérage et rangement','Lavage des sols'] },
    { n:'Nettoyage de fauteuils et canapés', k:'fauteuil,canape,salon,shampouinage', t:['Shampouinage de canapé','Nettoyage de fauteuils','Détachage de tissus','Nettoyage de tapis et moquettes'] },
    { n:'Nettoyage de matelas', k:'matelas,literie,desinfection', t:['Nettoyage et désinfection de matelas','Élimination des acariens','Détachage de matelas'] },
    { n:'Repassage', k:'repassage,linge,vetements', t:['Repassage à domicile','Repassage au kilo'] },
    { n:'Lessive / blanchisserie', k:'lessive,lavage,linge,blanchisserie,pressing', t:['Lavage de linge','Lavage de rideaux','Lavage de couettes'] } ] },
  { n:'Bureaux & commerces', sv:[
    { n:'Nettoyage de bureaux', k:'bureau,entreprise,locaux', t:['Nettoyage quotidien de bureaux','Nettoyage de vitres','Entretien de salles de réunion'] },
    { n:'Nettoyage de commerces', k:'magasin,boutique,commerce', t:['Nettoyage de surface de vente','Nettoyage de vitrines'] },
    { n:'Nettoyage de fin de chantier', k:'chantier,apres travaux,gros nettoyage', t:['Évacuation de gravats légers','Nettoyage complet après travaux'] } ] },
  { n:'Spécialisé', sv:[
    { n:'Nettoyage de vitres', k:'vitres,fenetres,baies', t:['Lavage de vitres intérieures','Lavage de vitres extérieures','Vitres en hauteur'] },
    { n:'Désinfection & désinsectisation', k:'desinfection,cafards,moustiques,punaises,rats,deratisation', t:['Désinsectisation (cafards, punaises)','Dératisation','Désinfection de locaux','Traitement anti-moustiques'] },
    { n:'Vidange de fosse septique', k:'fosse,septique,vidange,wc', t:['Vidange de fosse septique','Curage de canalisations'] },
    { n:'Entretien de piscine', k:'piscine,traitement eau', t:['Nettoyage de piscine','Traitement de l\u2019eau'] } ] } ] },

{ m:'Plomberie', i:'🔧', sc:[
  { n:'Installation', sv:[
    { n:'Installation sanitaire', k:'plombier,lavabo,wc,douche,installation', t:['Installation d\u2019un lavabo','Installation d\u2019un WC','Installation d\u2019une douche','Installation d\u2019un chauffe-eau','Installation d\u2019un évier'] },
    { n:'Installation de tuyauterie', k:'tuyau,canalisation,raccordement', t:['Pose de tuyauterie neuve','Raccordement d\u2019eau','Installation de surpresseur'] } ] },
  { n:'Réparation & dépannage', sv:[
    { n:'Réparation de fuite', k:'fuite,eau,urgence,robinet qui coule', t:['Réparation de fuite d\u2019eau','Remplacement d\u2019un robinet','Réparation de chasse d\u2019eau','Remplacement de joint'] },
    { n:'Débouchage', k:'bouche,debouchage,evier,wc bouche,canalisation', t:['Débouchage d\u2019évier','Débouchage de WC','Débouchage de canalisation','Débouchage de douche'] },
    { n:'Dépannage chauffe-eau', k:'chauffe-eau,eau chaude', t:['Réparation de chauffe-eau','Détartrage de chauffe-eau'] } ] } ] },

{ m:'Électricité', i:'⚡', sc:[
  { n:'Installation', sv:[
    { n:'Installation électrique', k:'electricien,cablage,tableau,installation', t:['Installation complète d\u2019une maison','Pose de tableau électrique','Ajout de prises et interrupteurs','Pose de luminaires','Installation de ventilateurs plafonniers'] },
    { n:'Compteur & branchement', k:'compteur,cie,branchement', t:['Préparation dossier branchement','Mise en conformité'] } ] },
  { n:'Dépannage', sv:[
    { n:'Dépannage électrique', k:'panne,courant,court-circuit,urgence', t:['Recherche de panne','Réparation de court-circuit','Remplacement de disjoncteur','Réparation de prises'] } ] },
  { n:'Énergie solaire', sv:[
    { n:'Installation solaire', k:'solaire,panneau,batterie,energie', t:['Installation de panneaux solaires','Installation de batteries','Entretien d\u2019installation solaire'] } ] } ] },

{ m:'Climatisation & froid', i:'❄️', sc:[
  { n:'Climatisation', sv:[
    { n:'Installation de climatiseur', k:'climatiseur,split,clim,pose', t:['Pose de split','Déplacement de climatiseur','Installation gainable'] },
    { n:'Entretien & recharge', k:'entretien clim,gaz,recharge,nettoyage clim', t:['Nettoyage de climatiseur','Recharge de gaz','Entretien périodique'] },
    { n:'Dépannage climatiseur', k:'clim en panne,fuite clim,ne refroidit plus', t:['Diagnostic de panne','Réparation de climatiseur'] } ] },
  { n:'Froid', sv:[
    { n:'Réparation réfrigérateur & congélateur', k:'frigo,refrigerateur,congelateur,chambre froide', t:['Réparation de réfrigérateur','Réparation de congélateur','Recharge de gaz frigo','Installation de chambre froide'] } ] } ] },

{ m:'Maçonnerie & construction', i:'🧱', sc:[
  { n:'Gros œuvre', sv:[
    { n:'Construction', k:'macon,construction,batir,fondation,dalle', t:['Fondations','Élévation de murs','Coulage de dalle','Construction de clôture'] },
    { n:'Rénovation', k:'renovation,reprise,fissure', t:['Réparation de fissures','Reprise de murs','Démolition partielle'] } ] },
  { n:'Finitions', sv:[
    { n:'Crépissage & enduits', k:'crepissage,enduit,lissage', t:['Crépissage de murs','Enduit de lissage'] },
    { n:'Chape & bétonnage', k:'chape,beton,cour', t:['Chape de sol','Bétonnage de cour'] } ] } ] },

{ m:'Peinture & décoration', i:'🎨', sc:[
  { n:'Peinture', sv:[
    { n:'Peinture intérieure', k:'peintre,peinture,murs,plafond', t:['Peinture de chambres','Peinture de salon','Peinture de plafond','Mise en peinture complète'] },
    { n:'Peinture extérieure', k:'facade,exterieur', t:['Peinture de façade','Peinture de clôture'] } ] },
  { n:'Décoration', sv:[
    { n:'Décoration d\u2019intérieur', k:'decoration,deco,amenagement', t:['Conseil en décoration','Pose de papier peint','Pose de corniches et moulures','Décoration de plafond (staff)'] } ] } ] },

{ m:'Menuiserie bois', i:'🪚', sc:[
  { n:'Meubles', sv:[
    { n:'Fabrication de meubles', k:'menuisier,meuble,armoire,table,lit,bois', t:['Fabrication d\u2019une armoire','Fabrication d\u2019un lit','Fabrication d\u2019une table','Fabrication de placards','Installation d\u2019étagères'] },
    { n:'Réparation de meubles', k:'reparation meuble,porte,retouche', t:['Réparation d\u2019une porte','Réparation de meuble','Changement de serrure de meuble'] } ] },
  { n:'Bâtiment', sv:[
    { n:'Portes & fenêtres bois', k:'porte,fenetre,pose,bois', t:['Pose de porte','Pose de fenêtre','Réglage de porte qui frotte'] },
    { n:'Charpente & coffrage', k:'charpente,coffrage,toiture bois', t:['Charpente de toiture','Coffrage'] } ] } ] },

{ m:'Menuiserie aluminium & vitrerie', i:'🪟', sc:[
  { n:'Aluminium', sv:[
    { n:'Fenêtres & baies alu', k:'alu,aluminium,baie,coulissante,fenetre', t:['Fabrication de fenêtres alu','Pose de baies coulissantes','Moustiquaires'] },
    { n:'Portes & façades alu', k:'porte alu,facade,vitrine', t:['Porte en aluminium','Façade de magasin','Cloisons alu'] } ] },
  { n:'Vitrerie', sv:[
    { n:'Vitrerie', k:'vitre,vitrier,miroir,verre', t:['Remplacement de vitre cassée','Pose de miroirs','Découpe de verre'] } ] } ] },

{ m:'Métallerie & soudure', i:'🔩', sc:[
  { n:'Ferronnerie', sv:[
    { n:'Portails & grilles', k:'soudeur,portail,grille,fer,forge', t:['Fabrication de portail','Fabrication de grilles de protection','Rampes d\u2019escalier','Réparation de portail'] },
    { n:'Soudure diverse', k:'soudure,metal,reparation', t:['Soudure de réparation','Fabrication métallique sur mesure','Hangars et préaux'] } ] } ] },

{ m:'Carrelage & revêtements', i:'◻️', sc:[
  { n:'Pose', sv:[
    { n:'Pose de carrelage', k:'carreleur,carrelage,faience,sol', t:['Carrelage de sol','Faïence murale','Carrelage de salle de bain','Carrelage de terrasse'] },
    { n:'Autres revêtements', k:'parquet,moquette,pvc,revetement', t:['Pose de parquet','Pose de sol PVC','Pose de moquette'] } ] } ] },

{ m:'Plâtrerie & faux plafonds', i:'🏠', sc:[
  { n:'Plâtrerie', sv:[
    { n:'Faux plafonds & staff', k:'platre,staff,faux plafond,placo,gypse', t:['Faux plafond en staff','Faux plafond placo','Corniches décoratives','Cloisons sèches'] } ] } ] },

{ m:'Architecture & études', i:'📐', sc:[
  { n:'Conception', sv:[
    { n:'Plans & conception', k:'architecte,plan,conception,permis', t:['Plan de maison','Plan 3D','Dossier de permis de construire'] },
    { n:'Suivi de chantier', k:'suivi,chantier,controle', t:['Suivi de chantier','Métré et devis quantitatif'] },
    { n:'Topographie & géomètre', k:'topographie,bornage,terrain,geometre', t:['Bornage de terrain','Levé topographique'] } ] } ] },

{ m:'Électroménager', i:'🔌', sc:[
  { n:'Réparation', sv:[
    { n:'Réparation d\u2019électroménager', k:'machine a laver,four,micro-onde,cuisiniere,reparation', t:['Réparation de machine à laver','Réparation de cuisinière','Réparation de micro-ondes','Réparation de ventilateur','Installation d\u2019électroménager'] } ] } ] },

{ m:'Informatique', i:'💻', sc:[
  { n:'Dépannage & maintenance', sv:[
    { n:'Réparation d\u2019ordinateur', k:'ordinateur,pc,laptop,lent,virus,ecran', t:['Réparation d\u2019ordinateur','Suppression de virus','Remplacement d\u2019écran','Récupération de données','Formatage et réinstallation'] },
    { n:'Maintenance pour entreprises', k:'parc,maintenance,entreprise', t:['Maintenance de parc informatique','Installation de logiciels'] } ] },
  { n:'Développement & web', sv:[
    { n:'Création de site / application', k:'site web,application,developpeur', t:['Création de site vitrine','Création de boutique en ligne','Développement d\u2019application'] } ] } ] },

{ m:'Téléphones & électronique', i:'📱', sc:[
  { n:'Réparation', sv:[
    { n:'Réparation de téléphone', k:'telephone,ecran casse,batterie,smartphone,tablette', t:['Remplacement d\u2019écran','Remplacement de batterie','Réparation de connecteur de charge','Déblocage / configuration'] },
    { n:'Réparation TV & électronique', k:'television,tv,ecran,decodeur,ampli', t:['Réparation de télévision','Installation de décodeur','Fixation murale de TV','Réparation d\u2019amplificateur'] } ] } ] },

{ m:'Réseaux & internet', i:'📡', sc:[
  { n:'Installation', sv:[
    { n:'Installation internet & wifi', k:'wifi,internet,routeur,fibre,reseau', t:['Installation de routeur wifi','Extension de couverture wifi','Câblage réseau','Configuration fibre'] },
    { n:'Caméras & vidéosurveillance', k:'camera,surveillance,securite,videosurveillance', t:['Installation de caméras','Configuration à distance','Maintenance de système'] },
    { n:'Antennes & paraboles', k:'antenne,parabole,canal', t:['Installation de parabole','Réglage d\u2019antenne'] } ] } ] },

{ m:'Mécanique automobile', i:'🚗', sc:[
  { n:'Entretien & réparation', sv:[
    { n:'Mécanique générale', k:'mecanicien,voiture,panne,moteur,vidange', t:['Diagnostic de panne','Vidange','Réparation moteur','Freins et plaquettes','Embrayage','Suspension'] },
    { n:'Électricité automobile', k:'electricite auto,batterie,demarreur,alternateur', t:['Remplacement de batterie','Réparation de démarreur','Diagnostic électronique','Climatisation auto'] },
    { n:'Pneus & vulcanisation', k:'pneu,crevaison,vulcanisateur,equilibrage', t:['Réparation de crevaison','Remplacement de pneus','Équilibrage','Parallélisme'] },
    { n:'Carrosserie & peinture auto', k:'carrosserie,tolerie,peinture voiture,choc', t:['Débosselage','Peinture de carrosserie','Remplacement de pare-brise'] },
    { n:'Dépannage / remorquage', k:'remorquage,depannage,panne route', t:['Remorquage de véhicule','Dépannage sur route','Démarrage de batterie'] } ] } ] },

{ m:'Moto & engins 2 roues', i:'🏍️', sc:[
  { n:'Réparation', sv:[
    { n:'Mécanique moto', k:'moto,scooter,reparation moto,vidange moto', t:['Réparation de moto','Entretien et vidange','Réparation de scooter','Remplacement de pièces'] } ] } ] },

{ m:'Lavage auto & moto', i:'🫧', sc:[
  { n:'Lavage', sv:[
    { n:'Lavage de véhicule', k:'lavage,voiture,interieur,lustrage', t:['Lavage extérieur','Nettoyage intérieur complet','Lustrage et polissage','Lavage moteur','Lavage à domicile'] } ] } ] },

{ m:'Transport & livraison', i:'🚚', sc:[
  { n:'Transport', sv:[
    { n:'Transport de personnes', k:'chauffeur,course,deplacement,taxi', t:['Chauffeur privé','Course en ville','Transport inter-villes','Navette événement'] },
    { n:'Transport de marchandises', k:'marchandise,fret,camion,tricycle', t:['Transport par tricycle','Transport par camionnette','Transport de matériaux'] } ] },
  { n:'Livraison', sv:[
    { n:'Livraison express', k:'livraison,coursier,colis,repas', t:['Livraison de colis','Course et achats','Livraison de repas','Livraison de documents'] } ] },
  { n:'Déménagement', sv:[
    { n:'Déménagement', k:'demenagement,cartons,transport meubles', t:['Déménagement complet','Transport de meubles','Emballage et cartons','Monte-meubles / manutention'] } ] } ] },

{ m:'Jardinage & espaces verts', i:'🌿', sc:[
  { n:'Entretien', sv:[
    { n:'Entretien de jardin', k:'jardinier,pelouse,herbe,taille,debroussaillage', t:['Tonte de pelouse','Taille de haies et arbres','Débroussaillage','Désherbage','Entretien régulier'] },
    { n:'Aménagement paysager', k:'amenagement,paysagiste,gazon,plantation', t:['Pose de gazon','Création de jardin','Plantation d\u2019arbres','Arrosage automatique'] },
    { n:'Abattage & élagage', k:'abattage,arbre,elagage', t:['Abattage d\u2019arbre','Élagage en hauteur','Évacuation de branchages'] } ] } ] },

{ m:'Agriculture & élevage', i:'🌾', sc:[
  { n:'Travaux agricoles', sv:[
    { n:'Main d\u2019œuvre agricole', k:'champ,plantation,recolte,defrichage,cacao,hevea', t:['Défrichage de terrain','Entretien de plantation','Récolte','Traitement phytosanitaire'] },
    { n:'Conseil agricole', k:'agronome,conseil,culture', t:['Conseil en culture','Analyse et préparation de sol'] } ] },
  { n:'Élevage', sv:[
    { n:'Services d\u2019élevage', k:'elevage,volaille,poulet,betail,porc', t:['Construction de poulailler','Suivi d\u2019élevage','Soins vétérinaires de base','Vaccination de volaille'] } ] } ] },

{ m:'Couture & mode', i:'🧵', sc:[
  { n:'Couture', sv:[
    { n:'Confection sur mesure', k:'couturier,couturiere,pagne,robe,costume,tenue', t:['Tenue en pagne sur mesure','Robe de cérémonie','Costume homme','Tenue traditionnelle','Uniformes'] },
    { n:'Retouches', k:'retouche,ourlet,fermeture,ajustement', t:['Ourlet','Remplacement de fermeture','Ajustement de vêtement','Réparation de couture'] } ] },
  { n:'Mode & accessoires', sv:[
    { n:'Stylisme & accessoires', k:'styliste,mode,sac,perles,accessoires', t:['Création de collection','Confection d\u2019accessoires','Conseil en style'] } ] } ] },

{ m:'Coiffure & beauté', i:'💇', sc:[
  { n:'Coiffure', sv:[
    { n:'Coiffure femme', k:'coiffure,tresses,meches,tissage,perruque,nattes', t:['Tresses','Tissage','Pose de perruque','Défrisage','Coupe et brushing','Coiffure à domicile'] },
    { n:'Coiffure homme', k:'coiffeur,barbier,degrade,barbe', t:['Coupe homme','Dégradé','Taille de barbe','Coiffure enfant'] } ] },
  { n:'Esthétique', sv:[
    { n:'Soins esthétiques', k:'esthetique,manucure,pedicure,ongles,soins visage,epilation', t:['Manucure','Pédicure','Pose d\u2019ongles','Soin du visage','Épilation','Massage bien-être'] },
    { n:'Maquillage', k:'maquillage,makeup,mariee', t:['Maquillage de mariée','Maquillage événement','Cours d\u2019auto-maquillage'] } ] } ] },

{ m:'Photo & vidéo', i:'📸', sc:[
  { n:'Prestations', sv:[
    { n:'Photographie', k:'photographe,photo,shooting,mariage,portrait', t:['Reportage mariage','Shooting portrait','Photos d\u2019événement','Photos produits','Photos d\u2019identité à domicile'] },
    { n:'Vidéo & montage', k:'video,cameraman,montage,drone,clip', t:['Captation d\u2019événement','Montage vidéo','Prises de vue drone','Clip et publicité'] } ] } ] },

{ m:'Événementiel', i:'🎉', sc:[
  { n:'Organisation', sv:[
    { n:'Organisation d\u2019événements', k:'evenement,mariage,anniversaire,bapteme,funerailles,organisation', t:['Organisation de mariage','Anniversaire','Baptême','Cérémonie d\u2019entreprise'] },
    { n:'Location de matériel', k:'location,chaises,baches,sono,chapiteaux', t:['Location de chaises et tables','Location de bâches/chapiteaux','Location de sonorisation','Location de vaisselle'] },
    { n:'Animation & sono', k:'dj,animation,sono,orchestre,animateur', t:['DJ','Animateur / MC','Groupe de musique','Sonorisation d\u2019événement'] },
    { n:'Décoration d\u2019événements', k:'decoration mariage,salle,ballons', t:['Décoration de salle','Décoration de mariage','Arches et ballons'] } ] } ] },

{ m:'Cuisine & traiteur', i:'🍲', sc:[
  { n:'Traiteur', sv:[
    { n:'Service traiteur', k:'traiteur,buffet,mariage,repas,plats', t:['Buffet de mariage','Repas d\u2019entreprise','Cocktail et amuse-bouche','Plats traditionnels ivoiriens'] },
    { n:'Cuisinier à domicile', k:'cuisinier,cuisiniere,domicile,repas maison', t:['Cuisinier à domicile','Préparation de repas de la semaine','Chef pour un soir'] } ] },
  { n:'Pâtisserie', sv:[
    { n:'Gâteaux & pâtisserie', k:'patisserie,gateau,anniversaire,mariage', t:['Gâteau d\u2019anniversaire','Gâteau de mariage','Pâtisseries assorties'] } ] } ] },

{ m:'Cours & formation', i:'📚', sc:[
  { n:'Cours à domicile', sv:[
    { n:'Soutien scolaire', k:'cours,repetiteur,maths,francais,anglais,physique,domicile', t:['Mathématiques','Français','Anglais','Physique-Chimie','Préparation BEPC','Préparation BAC','Aide aux devoirs (primaire)'] },
    { n:'Cours de langues', k:'anglais,allemand,espagnol,langue', t:['Anglais','Espagnol','Allemand','Chinois'] },
    { n:'Cours d\u2019informatique', k:'informatique,bureautique,word,excel', t:['Initiation à l\u2019ordinateur','Word / Excel / PowerPoint','Internet et e-mail'] } ] },
  { n:'Formation professionnelle', sv:[
    { n:'Formations métiers', k:'formation,apprentissage,metier', t:['Formation en couture','Formation en coiffure','Formation en pâtisserie','Formation en informatique','Permis de conduire (accompagnement)'] },
    { n:'Musique & arts', k:'musique,piano,guitare,chant,danse,dessin', t:['Cours de piano','Cours de guitare','Cours de chant','Cours de danse','Cours de dessin'] } ] } ] },

{ m:'Rédaction & traduction', i:'✍️', sc:[
  { n:'Services linguistiques', sv:[
    { n:'Traduction', k:'traduction,traducteur,anglais,documents', t:['Traduction de documents','Interprétariat','Traduction certifiée'] },
    { n:'Rédaction', k:'redaction,cv,lettre,memoire,rapport,saisie', t:['Rédaction / correction de CV','Lettre de motivation','Mise en forme de mémoire','Saisie de documents','Correction et relecture'] } ] } ] },

{ m:'Administratif & comptabilité', i:'📋', sc:[
  { n:'Services administratifs', sv:[
    { n:'Démarches administratives', k:'demarche,papiers,dossier,formalites', t:['Aide aux démarches administratives','Constitution de dossiers','Légalisation de documents'] },
    { n:'Assistance professionnelle', k:'assistant,secretariat,gestion', t:['Secrétariat à distance','Gestion d\u2019agenda','Classement et archivage'] } ] },
  { n:'Comptabilité & gestion', sv:[
    { n:'Comptabilité', k:'comptable,bilan,impots,declaration,gestion', t:['Tenue de comptabilité','Déclarations fiscales','Bilan annuel','Paie du personnel','Création d\u2019entreprise'] } ] } ] },

{ m:'Marketing & communication', i:'📣', sc:[
  { n:'Communication', sv:[
    { n:'Community management', k:'reseaux sociaux,facebook,tiktok,communication,publicite', t:['Gestion de pages réseaux sociaux','Campagnes publicitaires','Création de contenu'] },
    { n:'Design graphique', k:'graphiste,logo,affiche,flyer,design', t:['Création de logo','Affiches et flyers','Cartes de visite','Habillage réseaux sociaux'] },
    { n:'Impression & supports', k:'imprimerie,banderole,tshirt,flocage', t:['Impression de banderoles','Flocage de t-shirts','Impression de documents'] } ] } ] },

{ m:'Sécurité & gardiennage', i:'🛡️', sc:[
  { n:'Surveillance', sv:[
    { n:'Gardiennage', k:'gardien,vigile,securite,surveillance', t:['Gardien de résidence','Vigile de commerce','Sécurité d\u2019événement','Gardien de chantier'] },
    { n:'Serrurerie & protection', k:'serrurier,serrure,cle,porte bloquee,coffre', t:['Ouverture de porte claquée','Remplacement de serrure','Reproduction de clés','Installation de coffre-fort'] } ] } ] },

{ m:'Aide à la personne', i:'🤝', sc:[
  { n:'Famille', sv:[
    { n:'Garde d\u2019enfants', k:'nounou,garde,enfant,bebe,baby-sitting', t:['Nounou à domicile','Baby-sitting ponctuel','Sortie d\u2019école','Garde de nuit'] },
    { n:'Aide aux personnes âgées', k:'personne agee,accompagnement,aide,garde malade', t:['Accompagnement quotidien','Garde-malade','Courses et repas','Compagnie et présence'] },
    { n:'Aide ménagère familiale', k:'aide menagere,domestique,maison', t:['Aide ménagère à temps plein','Aide ménagère à temps partiel'] } ] },
  { n:'Santé & bien-être', sv:[
    { n:'Soins à domicile', k:'infirmier,soins,injection,pansement,tension', t:['Soins infirmiers à domicile','Injections et pansements','Suivi de tension / diabète'] },
    { n:'Sport & coaching', k:'coach,sport,fitness,gym', t:['Coach sportif personnel','Cours de fitness en groupe','Programme de remise en forme'] } ] } ] },

{ m:'Animaux', i:'🐾', sc:[
  { n:'Services animaliers', sv:[
    { n:'Soins & garde d\u2019animaux', k:'chien,chat,veterinaire,toilettage,garde animaux,dressage', t:['Toilettage','Garde d\u2019animaux','Promenade de chien','Dressage de chien','Soins vétérinaires de base'] } ] } ] },

{ m:'Services funéraires', i:'🕊️', sc:[
  { n:'Accompagnement', sv:[
    { n:'Organisation d\u2019obsèques', k:'funerailles,obseques,deuil,pompes funebres', t:['Organisation de veillée','Transport funéraire','Location de matériel funéraire','Coordination de cérémonie'] } ] } ] },

{ m:'Commerce & vente', i:'🛒', sc:[
  { n:'Services commerciaux', sv:[
    { n:'Vente & installation d\u2019équipements', k:'vente,installation,equipement,fourniture', t:['Fourniture et pose d\u2019équipements','Installation de matériel acheté','Conseil à l\u2019achat'] },
    { n:'Gestion de boutique', k:'vendeur,gerant,boutique,inventaire', t:['Vendeur temporaire','Inventaire de stock','Gestion de point de vente'] } ] } ] },

{ m:'Artisanat & réparations diverses', i:'🧰', sc:[
  { n:'Artisanat', sv:[
    { n:'Artisanat d\u2019art', k:'artisan,sculpture,poterie,tissage,objet', t:['Objets décoratifs sur mesure','Sculpture sur bois','Vannerie et tissage traditionnel'] },
    { n:'Cordonnerie & maroquinerie', k:'cordonnier,chaussure,sac,cuir,reparation chaussure', t:['Réparation de chaussures','Réparation de sacs','Travaux sur cuir'] },
    { n:'Réparation d\u2019objets divers', k:'reparation,objet,bricolage,montage', t:['Petites réparations à domicile','Montage de meubles en kit','Fixations et accrochages','Bricolage divers'] } ] } ] },

{ m:'Services aux entreprises', i:'🏢', sc:[
  { n:'Prestations B2B', sv:[
    { n:'Personnel temporaire', k:'interim,personnel,main d\u2019oeuvre,entreprise', t:['Mise à disposition de personnel','Manutentionnaires','Hôtesses d\u2019accueil'] },
    { n:'Entretien de locaux professionnels', k:'entretien,locaux,contrat,entreprise', t:['Contrat d\u2019entretien régulier','Nettoyage industriel','Entretien d\u2019espaces communs'] } ] } ] }
];

// ============================================================
// VILLES ET LOCALITÉS DE CÔTE D'IVOIRE (liste évolutive)
// ============================================================
const VILLES = [
'Abidjan','Abengourou','Aboisso','Adiaké','Adzopé','Agboville','Agnibilékrou','Akoupé','Alépé','Anyama',
'Arrah','Assinie','Ayamé','Azaguié','Bangolo','Béoumi','Bettié','Biankouma','Bingerville','Blolequin',
'Bocanda','Bondoukou','Bongouanou','Bonoua','Bouaflé','Bouaké','Bouna','Boundiali','Brobo','Buyo',
'Dabakala','Dabou','Daloa','Danané','Daoukro','Dianra','Didiévi','Dimbokro','Divo','Djékanou',
'Doropo','Duékoué','Ferkessédougou','Fresco','Gagnoa','Gbéléban','Gohitafla','Grand-Bassam','Grand-Lahou','Grand-Zattry',
'Guéyo','Guibéroua','Guiglo','Guitry','Issia','Jacqueville','Kani','Katiola','Kong','Korhogo',
'Kouassi-Kouassikro','Koun-Fao','Kouto','Lakota','M\u2019Bahiakro','M\u2019Batto','Madinani','Man','Mankono','Méagui',
'Minignan','Mirador','Nassian','Niakara','Niablé','Odienné','Ouangolodougou','Ouéllé','Oumé','Prikro',
'Sakassou','San-Pédro','Sandégué','Sassandra','Séguéla','Séguélon','Sikensi','Sinématiali','Sinfra','Songon',
'Soubré','Tabou','Taï','Tanda','Téhini','Tengréla','Tiapoum','Tiassalé','Tiébissou','Tiéningboué',
'Tortiya','Touba','Toulepleu','Toumodi','Transua','Vavoua','Yamoussoukro','Zouan-Hounien','Zoukougbeu','Zuénoula',
// Grandes communes d'Abidjan (utiles pour la recherche)
'Abobo','Adjamé','Attécoubé','Cocody','Koumassi','Marcory','Plateau','Port-Bouët','Treichville','Yopougon'
];

module.exports = { METIERS, VILLES };
