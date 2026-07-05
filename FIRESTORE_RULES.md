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

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() { return request.auth != null; }
    function verified() { return signedIn() && request.auth.token.email_verified == true; }
    function myEmail()  { return request.auth.token.email.lower(); }

    // Dati del proprietario: solo lui, con email verificata.
    match /users/{uid} {
      allow read, write: if verified() && request.auth.uid == uid;

      match /{store}/{docId} {
        allow read, write: if verified() && request.auth.uid == uid;
      }

      // Statement condivisi: il proprietario scrive, il cliente destinatario legge.
      match /statements/{clientId} {
        allow write: if verified() && request.auth.uid == uid;
        allow read:  if verified() &&
          (request.auth.uid == uid ||
           myEmail() == resource.data.viewerEmail);
      }
    }

    // Indice dei collegamenti: scrive solo il proprietario del link,
    // legge solo il destinatario (query where viewerEmail == propria email).
    match /links/{linkId} {
      allow write: if verified() && request.auth.uid == resource.data.ownerUid
                   || verified() && request.auth.uid == request.resource.data.ownerUid;
      allow read:  if verified() && myEmail() == resource.data.viewerEmail;
    }
  }
}
```

## Note

- `email_verified` è essenziale: senza, chiunque può registrare un account
  Firebase con l'email di un cliente (non confermata) e leggere il suo statement.
  Il client applica lo stesso controllo (vedi `attachClientStatementByEmail` in
  index.html), ma solo le regole lo garantiscono.
- Lo statement contiene già `viewerEmail` al livello del documento (vedi
  `buildClientStatement` in index.html), quindi la regola di lettura sopra
  funziona senza modifiche al codice.
- Dopo ogni modifica alle regole, testare con il simulatore della console sia
  il proprietario sia un account cliente verificato e uno non verificato.
