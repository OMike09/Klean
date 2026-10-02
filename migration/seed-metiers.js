// migration/seed-metiers.js - 65+ métiers Côte d'Ivoire
const { db } = require('../db');
const METIERS = [
  ["Nettoyage et entretien","🧹"],["Plomberie","🚰"],["Électricité","⚡"],["Climatisation et froid","❄️"],["Maçonnerie","🧱"],["Peinture","🎨"],["Menuiserie bois","🪵"],["Menuiserie aluminium","🪟"],["Métallerie / soudure","🔩"],["Carrelage","🏠"],["Plâtrerie","🧱"],["Décoration","✨"],["Architecture et conception","📐"],["Construction","🏗️"],["Réparation et maintenance","🔧"],["Électroménager","🔌"],["Informatique","💻"],["Téléphones et appareils électroniques","📱"],["Réseaux et installation internet","🌐"],["Mécanique automobile","🚗"],["Moto","🏍️"],["Lavage automobile","🚿"],["Transport","🚚"],["Livraison","📦"],["Déménagement","🏠"],["Jardinage","🌿"],["Agriculture et travaux agricoles","🌾"],["Élevage","🐄"],["Couture","✂️"],["Mode","👗"],["Coiffure","💇"],["Esthétique","💅"],["Maquillage","💄"],["Photographie","📸"],["Vidéo","🎥"],["Événementiel","🎉"],["Traiteur","🍽️"],["Cuisine","👨‍🍳"],["Pâtisserie","🎂"],["Cours particuliers","📚"],["Formation","🎓"],["Traduction","🌐"],["Rédaction","✍️"],["Services administratifs","📋"],["Comptabilité","🧮"],["Assistance professionnelle","🤝"],["Marketing et communication","📢"],["Design graphique","🎨"],["Services numériques","💻"],["Sécurité","🛡️"],["Gardiennage","👮"],["Assistance aux personnes","🤗"],["Services pour enfants","👶"],["Services pour personnes âgées","👴"],["Services liés aux animaux","🐾"],["Services funéraires","🕊️"],["Services commerciaux","🏪"],["Vente et installation","🛒"],["Artisanat","🎨"],["Réparation d'objets","🔧"],["Installation d'équipements","🔌"],["Services pour entreprises","🏢"],["Services pour particuliers","🏠"]
];
try{
  const cnt=db.prepare("SELECT count(*) as n FROM metiers").get().n;
  if(cnt===0){
    const ins=db.prepare("INSERT INTO metiers(name,icon,sort) VALUES(?,?,?)");
    METIERS.forEach((m,i)=>ins.run(m[0],m[1],i));
    console.log(`🏗️ Métiers seed: ${METIERS.length} créés`);
    // Exemple sous-catégories pour Plomberie
    const plomb=db.prepare("SELECT id FROM metiers WHERE name='Plomberie'").get();
    if(plomb){
      const sc=db.prepare("INSERT INTO sous_categories(metier_id,name,sort) VALUES(?,?,?)");
      const s1=sc.run(plomb.id,"Installation",0).lastInsertRowid;
      const s2=sc.run(plomb.id,"Réparation",1).lastInsertRowid;
      const sv=db.prepare("INSERT INTO services2(sous_categorie_id,metier_id,name,sort) VALUES(?,?,?,?)");
      const sv1=sv.run(s1,plomb.id,"Installation d'un lavabo",0).lastInsertRowid;
      sv.run(s1,plomb.id,"Remplacement d'un robinet",1);
      sv.run(s1,plomb.id,"Installation de tuyauterie",2);
      const t=db.prepare("INSERT INTO taches(service_id,name) VALUES(?,?)");
      t.run(sv1,"Dépose de l'ancien lavabo"); t.run(sv1,"Pose et raccordement");
    }
  }
}catch(e){ console.error("seed metiers err",e.message); }
