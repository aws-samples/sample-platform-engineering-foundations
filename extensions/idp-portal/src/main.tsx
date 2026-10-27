// A stylesheet do One Theme vem ANTES de qualquer componente ou CSS do app: a ordem dos imports é a
// ordem em que o Vite emite o CSS, e o CSS dos componentes precisa sobrescrever o global, nunca o contrário.
import '@cloudscape-design/global-styles/index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { bootstrapTheme } from './theme';
import { AUTH_MODE } from './platform/auth/authAdapter';
import { bootstrapCognito } from './platform/auth/cognito';
import App from './App';

// Classes de tema, modo e densidade no <body> antes do primeiro render (ver src/theme.ts).
bootstrapTheme();

// Flavor público (bearer): completa o login do Cognito ou redireciona para ele antes de renderizar.
// No bundle interno (harmony) o bootstrap devolve false sem tocar em nada e o app renderiza direto.
const render = () => ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if (AUTH_MODE === 'bearer') {
  void bootstrapCognito().then((ready) => { if (ready) render(); }).catch((error: unknown) => {
    console.error('cognito bootstrap failed', error);
    render();
  });
} else {
  render();
}
