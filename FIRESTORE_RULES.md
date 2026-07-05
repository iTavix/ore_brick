# Regole Firestore consigliate per HourFlow

L'`apiKey` Firebase nel sorgente è pubblica per design: **le regole di sicurezza
Firestore sono l'unica vera barriera** sui dati. Da applicare nella console
Firebase (progetto `brickboy-b008e`) → Firestore Database → Rules.

## Modello dati

- `users/{uid}` — documento del proprietario (settings, ruolo) + sottocollezioni
  `projects`, `entries`, `clients`, `payments`, `expenses`, `quotes`.
- `users/{ownerUid}/statements/{clientId}` — snapshot in sola lettura pubblicato
  per un cliente, indirizzato via email.
- `links/{ownerUid_clientId}` — indice: `{ ownerUid, clientId, viewerEmail }`.

## Regole consigliate

La verifica email (`email_verified`) è richiesta SOLO dove l'email è la chiave
d'accesso: la lettura degli statement/links da parte dei clienti. I dati propri
del proprietario sono protetti dall'uid, non dall'email: richiedere la verifica
anche lì bloccherebbe la sync di un account proprietario non ancora verificato.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn()  { return request.auth != null; }
    function verified()  { return signedIn() && request.auth.token.email_verified == true; }
    function myEmail()   { return request.auth.token.email.lower(); }
    function isOwner(uid) { return signedIn() && request.auth.uid == uid; }

    // Dati del proprietario: solo lui (barriera = uid).
    match /users/{uid} {
      allow read, write: if isOwner(uid);

      match /{store}/{docId} {
        allow read, write: if isOwner(uid);
      }

      // Statement condivisi: il proprietario scrive, il cliente destinatario
      // legge — ma solo con email VERIFICATA (l'email qui è la credenziale).
      match /statements/{clientId} {
        allow write: if isOwner(uid);
        allow read:  if isOwner(uid) ||
                        (verified() && myEmail() == resource.data.viewerEmail);
      }
    }

    // Indice dei collegamenti: crea/aggiorna/elimina solo il proprietario,
    // legge solo il destinatario (query where viewerEmail == propria email).
    match /links/{linkId} {
      allow create: if signedIn() && request.auth.uid == request.resource.data.ownerUid;
      allow update: if signedIn() && request.auth.uid == resource.data.ownerUid
                    && request.auth.uid == request.resource.data.ownerUid;
      allow delete: if signedIn() && request.auth.uid == resource.data.ownerUid;
      allow read:   if verified() && myEmail() == resource.data.viewerEmail;
    }
  }
}
```

## Note

- `email_verified` sulla lettura di statement/links è essenziale: senza, chiunque
  può registrare un account Firebase con l'email di un cliente (non confermata)
  e leggere il suo statement. Il client applica lo stesso controllo (vedi
  `attachClientStatementByEmail` in app.js), ma solo le regole lo garantiscono.
- Lo statement contiene già `viewerEmail` al livello del documento (vedi
  `buildClientStatement` in index.html), quindi la regola di lettura sopra
  funziona senza modifiche al codice.
- Dopo ogni modifica alle regole, testare con il simulatore della console sia
  il proprietario sia un account cliente verificato e uno non verificato.
